import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import { z } from "zod"
import {
  authorizeImmutableToolCall,
  type ImmutableToolAuthorization,
} from "./immutable-tool-authorization"
import type { TaskEventLedger } from "./task-event-ledger"
import type { TaskRunScope } from "./task-sidecar-store"

export type { ParsedTaskSpawn, TaskParseResult } from "./task-spawn-parser"
export { canonicalTaskProjection, parseTaskSpawn } from "./task-spawn-parser"

export type TaskSpawnRequest = {
  readonly toolName: string
  readonly toolCallId: string
  readonly input: unknown
  readonly sessionId: string
}

export type TaskSpawnGuardResult = { readonly block: true; readonly reason: string } | undefined

export type AuthorizedTaskSpawnRequest = {
  readonly authorization: Exclude<ImmutableToolAuthorization, { readonly kind: "pass_through" }>
  readonly sessionId: string
}

const PublicTaskAgentSchema = z.enum([
  "omp-lazy-explorer",
  "omp-lazy-librarian",
  "omp-lazy-metis",
  "omp-lazy-momus",
  "omp-lazy-planner",
  "omp-lazy-qa",
  "omp-lazy-researcher",
  "omp-lazy-reviewer",
  "omp-lazy-worker-high",
  "omp-lazy-worker-low",
  "omp-lazy-worker-medium",
])

const TaskSpawnPacketPolicySchema = z
  .object({
    packetHash: z.string().regex(/^[0-9a-f]{64}$/),
    tier: z.enum(["FAST", "STANDARD", "DEEP"]),
    allowedAgentTypes: z.array(PublicTaskAgentSchema).min(1).max(11).readonly(),
  })
  .strict()
  .superRefine((policy, context) => {
    if (new Set(policy.allowedAgentTypes).size !== policy.allowedAgentTypes.length) {
      context.addIssue({ code: "custom", message: "duplicate packet spawn agent" })
    }
  })

export type TaskSpawnPacketPolicy = z.infer<typeof TaskSpawnPacketPolicySchema>

const TierAgentEligibility = {
  FAST: [
    "omp-lazy-explorer",
    "omp-lazy-librarian",
    "omp-lazy-planner",
    "omp-lazy-researcher",
    "omp-lazy-worker-low",
  ],
  STANDARD: [
    "omp-lazy-explorer",
    "omp-lazy-librarian",
    "omp-lazy-metis",
    "omp-lazy-planner",
    "omp-lazy-qa",
    "omp-lazy-researcher",
    "omp-lazy-reviewer",
    "omp-lazy-worker-low",
    "omp-lazy-worker-medium",
  ],
  DEEP: PublicTaskAgentSchema.options,
} as const satisfies Record<TaskSpawnPacketPolicy["tier"], readonly string[]>

export function currentTaskSpawnPacketPolicy(
  scope: TaskRunScope,
): TaskSpawnPacketPolicy | undefined {
  if (scope.run.schemaVersion !== 2 || scope.ledger.schemaVersion !== 2) return undefined
  const { packetHash, tier } = scope.ledger
  if (packetHash === null || tier === null || scope.run.packetHash !== packetHash) return undefined
  return { packetHash, tier, allowedAgentTypes: TierAgentEligibility[tier] }
}

export class TaskSpawnGuard {
  constructor(
    readonly ledger: TaskEventLedger,
    readonly maxFanOut: number,
    readonly packetPolicy?: TaskSpawnPacketPolicy,
  ) {}

  async handle(request: TaskSpawnRequest): Promise<TaskSpawnGuardResult> {
    const authorization = authorizeImmutableToolCall(request)
    if (authorization.kind === "pass_through") return undefined
    try {
      const resolved = await this.ledger.resolve(request.sessionId)
      if (resolved.kind === "none") return undefined
      if (resolved.kind === "conflict") {
        return { block: true, reason: "omp-lazy: task state conflict" }
      }
      return this.handleAuthorized({ authorization, sessionId: request.sessionId })
    } catch (error) {
      if (error instanceof Error) {
        return { block: true, reason: "omp-lazy: task state conflict" }
      }
      throw error
    }
  }

  async handleAuthorized(request: AuthorizedTaskSpawnRequest): Promise<TaskSpawnGuardResult> {
    const authorization = request.authorization
    switch (authorization.kind) {
      case "denied":
        return { block: true, reason: authorization.reason }
      case "task":
        return this.#handleTask(request.sessionId, authorization)
      case "job":
        return this.#handleJob(request.sessionId, authorization)
      case "irc":
        return this.#handleIrc(request.sessionId, authorization)
      case "hub_wait":
        return this.#handleHubWait(request.sessionId, authorization)
      default:
        return authorization satisfies never
    }
  }

  async #handleTask(
    sessionId: string,
    authorization: Extract<ImmutableToolAuthorization, { readonly kind: "task" }>,
  ): Promise<TaskSpawnGuardResult> {
    try {
      if (!Number.isSafeInteger(this.maxFanOut) || this.maxFanOut < 1) {
        return { block: true, reason: "omp-lazy: invalid fan-out policy" }
      }
      const parsedPolicy =
        this.packetPolicy === undefined
          ? null
          : TaskSpawnPacketPolicySchema.safeParse(this.packetPolicy)
      if (parsedPolicy !== null && !parsedPolicy.success) {
        return { block: true, reason: "omp-lazy: invalid packet spawn policy" }
      }
      if (parsedPolicy?.success) {
        const eligible = new Set(TierAgentEligibility[parsedPolicy.data.tier])
        if (parsedPolicy.data.allowedAgentTypes.some((agent) => !eligible.has(agent))) {
          return { block: true, reason: "omp-lazy: tier-ineligible packet agent" }
        }
        const allowed = new Set(parsedPolicy.data.allowedAgentTypes)
        if (
          authorization.spawn.requests.some((spawnRequest) => {
            const requested = PublicTaskAgentSchema.safeParse(spawnRequest.agentType)
            return !requested.success || !allowed.has(requested.data)
          })
        ) {
          const tier = parsedPolicy.data.tier
          const sortedEligible = [...parsedPolicy.data.allowedAgentTypes].sort()
          return {
            block: true,
            reason: `omp-lazy: agent not allowed by packet (${tier} tier; eligible: ${sortedEligible.join(", ")})`,
          }
        }
      }
      const committed = await this.ledger.reserve(
        sessionId,
        {
          kind: "task_reserved",
          toolCallId: authorization.toolCallId,
          itemCount: authorization.spawn.itemCount,
          requests: authorization.spawn.requests,
        },
        this.maxFanOut,
      )
      if (committed.kind !== "scope") {
        return { block: true, reason: "omp-lazy: reservation conflict" }
      }
      if (committed.value === "limit") {
        return { block: true, reason: "omp-lazy: fan-out limit exceeded" }
      }
      return committed.value === "fact_conflict"
        ? { block: true, reason: "omp-lazy: reservation conflict" }
        : undefined
    } catch (error) {
      if (error instanceof Error) {
        return { block: true, reason: "omp-lazy: task state conflict" }
      }
      throw error
    }
  }

  async #handleJob(
    sessionId: string,
    authorization: Extract<ImmutableToolAuthorization, { readonly kind: "job" }>,
  ): Promise<TaskSpawnGuardResult> {
    const authorized = await this.ledger.authorize(sessionId, {
      toolCallId: authorization.toolCallId,
      control: authorization.control.control,
      inputKey: authorization.control.inputKey,
      targets: authorization.control.targets,
    })
    if (authorized.kind !== "scope") {
      return { block: true, reason: "omp-lazy: task state conflict" }
    }
    if (
      authorized.value === "unowned" ||
      (authorized.value === "no_generation" && authorization.control.targets.length > 0)
    ) {
      return { block: true, reason: "omp-lazy: unowned job" }
    }
    return undefined
  }

  async #handleIrc(
    sessionId: string,
    authorization: Extract<ImmutableToolAuthorization, { readonly kind: "irc" }>,
  ): Promise<TaskSpawnGuardResult> {
    if (authorization.control.kind === "passive" && authorization.control.targets.length === 0) {
      return undefined
    }
    const authorized = await this.ledger.authorize(sessionId, {
      toolCallId: authorization.toolCallId,
      control: authorization.control.kind === "send" ? "irc_send" : "irc_target",
      inputKey: authorization.control.inputKey,
      targets: authorization.control.targets,
    })
    return authorized.kind === "scope" && authorized.value === "authorized"
      ? undefined
      : { block: true, reason: "omp-lazy: unowned agent" }
  }

  async #handleHubWait(
    sessionId: string,
    authorization: Extract<ImmutableToolAuthorization, { readonly kind: "hub_wait" }>,
  ): Promise<TaskSpawnGuardResult> {
    const authorized = await this.ledger.authorizeHubWait(sessionId, {
      toolCallId: authorization.toolCallId,
      inputKey: authorization.control.inputKey,
      jobTargets: authorization.control.jobTargets,
      agentTargets: authorization.control.agentTargets,
    })
    if (authorized.kind !== "scope") {
      return { block: true, reason: "omp-lazy: task state conflict" }
    }
    if (authorized.value === "unowned_job") {
      return { block: true, reason: "omp-lazy: unowned job" }
    }
    if (authorized.value === "unowned_agent") {
      return { block: true, reason: "omp-lazy: unowned agent" }
    }
    return authorized.value === "authorized"
      ? undefined
      : { block: true, reason: "omp-lazy: task state conflict" }
  }
}

export function registerTaskSpawnGuard(api: Pick<ExtensionAPI, "on">, guard: TaskSpawnGuard): void {
  api.on("tool_call", async (event, context) =>
    guard.handle({
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      input: event.input,
      sessionId: context.sessionManager.getSessionId(),
    }),
  )
}
