import { createHash } from "node:crypto"
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import { z } from "zod"
import { matchActivation } from "./matcher"
import type {
  ActivationDecision,
  ActivationInput,
  ActivationStatePort,
  ActivationSuppressionPort,
  BeforeAgentStartInput,
  SuppressionReason,
  WorkflowActivationId,
} from "./types"

const inputSchema = z.object({
  sessionId: z.string().trim().min(1),
  source: z.enum(["interactive", "rpc", "extension"]),
  text: z.string(),
})
const beforeSchema = z.object({ sessionId: z.string().trim().min(1), prompt: z.string() })

type PendingToken = {
  readonly hash: string
  readonly workflow: WorkflowActivationId
  readonly command: `/${string}`
}

type SuppressionToken = {
  readonly hash: string
  readonly reason: SuppressionReason
}

function promptHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

export class ActivationProvenanceController implements ActivationSuppressionPort {
  readonly #pending = new Map<string, PendingToken>()
  readonly #suppressions = new Map<string, SuppressionToken>()
  readonly #commands = new Set<string>()

  constructor(readonly state: ActivationStatePort) {}

  async recordInput(input: ActivationInput): Promise<void> {
    const parsed = inputSchema.safeParse(input)
    if (!parsed.success) return
    const { sessionId, source, text } = parsed.data
    this.#pending.delete(sessionId)
    if (source === "extension") return
    const match = matchActivation(text)
    if (match === null) return
    this.#pending.set(sessionId, {
      hash: promptHash(text),
      workflow: match.workflow,
      command: match.command,
    })
  }

  async consumeBeforeAgentStart(input: BeforeAgentStartInput): Promise<ActivationDecision> {
    const parsed = beforeSchema.safeParse(input)
    if (!parsed.success) return { kind: "quiet" }
    const { sessionId, prompt } = parsed.data
    const hash = promptHash(prompt)
    const suppression = this.#suppressions.get(sessionId)
    if (suppression?.hash === hash) {
      this.#suppressions.delete(sessionId)
      return { kind: "quiet" }
    }
    if (suppression !== undefined) this.#suppressions.delete(sessionId)
    const token = this.#pending.get(sessionId)
    if (token === undefined) return { kind: "quiet" }
    this.#pending.delete(sessionId)
    if (token.hash !== hash || this.#commands.has(sessionId)) return { kind: "quiet" }
    if (await this.state.isActive(token.workflow, sessionId)) return { kind: "quiet" }

    // Idempotency: check if this directive was already activated in this session for the current run
    if (this.state.isDirectiveAlreadyActivated && this.state.currentRunId) {
      const currentRunId = await this.state.currentRunId(sessionId)
      const alreadyActivated = await this.state.isDirectiveAlreadyActivated(
        sessionId,
        token.workflow,
        currentRunId,
      )
      if (alreadyActivated) return { kind: "quiet" }
    }

    return { kind: "activate", workflow: token.workflow, command: token.command }
  }

  async suppressNext(request: {
    readonly sessionId: string
    readonly text: string
    readonly reason: SuppressionReason
  }): Promise<void> {
    const parsed = beforeSchema.safeParse({ sessionId: request.sessionId, prompt: request.text })
    if (!parsed.success) return
    this.#suppressions.set(parsed.data.sessionId, {
      hash: promptHash(parsed.data.prompt),
      reason: request.reason,
    })
  }

  async runCommand<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    this.#commands.add(sessionId)
    // Clear the directive activation record so the next trigger can re-inject
    if (this.state.clearDirectiveActivation) {
      await this.state.clearDirectiveActivation(sessionId)
    }
    try {
      return await operation()
    } finally {
      this.#commands.delete(sessionId)
    }
  }
}

export function registerTrustedActivation(
  api: Pick<ExtensionAPI, "on">,
  controller: ActivationProvenanceController,
): void {
  api.on("input", async (event, context) => {
    await controller.recordInput({
      sessionId: context.sessionManager.getSessionId(),
      source: event.source,
      text: event.text,
    })
  })
  api.on("before_agent_start", async (event, context) => {
    const decision = await controller.consumeBeforeAgentStart({
      sessionId: context.sessionManager.getSessionId(),
      prompt: event.prompt,
    })
    if (decision.kind === "quiet") return
    return {
      message: {
        customType: "omp-lazy-activation",
        content: `Activate ${decision.workflow} from trusted command ${decision.command}.`,
        display: false,
        details: decision,
      },
    }
  })
}
