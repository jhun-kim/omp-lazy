import type { AgentMessage } from "@oh-my-pi/pi-agent-core"
import type { Model } from "@oh-my-pi/pi-ai"
import type {
  AfterProviderResponseEvent,
  AutoRetryStartEvent,
  ContextEventResult,
  ExtensionAPI,
  ToolCallEventResult,
  ToolResultEventResult,
} from "@oh-my-pi/pi-coding-agent"
import { CATALOG_BUDGET_BYTES, RULES_BUDGET_BYTES } from "../context/rules-assembly"
import type { CompiledTaskPacket } from "../contracts/task-packet"
import {
  type MeteredResultContent,
  RetrievalBudgetGuard,
  type RetrievalBudgetSnapshot,
} from "../gates/retrieval-budget-guard"
import {
  compactStepContext,
  type StepContextCompileResult,
  TASK_PACKET_CUSTOM_TYPE,
  type TaskPacketMessage,
} from "../workflows/task-packet-compiler"
import { decodeIrcResult, isHubWaitStatusOnlyResult } from "./irc-result-codec"
import { decodeJobResult } from "./job-result-codec"
import { ModelCallObserver, type ModelCallSnapshot } from "./model-call-observer"
import type { StatusLinePublisher } from "./status-line-publisher"

export const RULES_CUSTOM_TYPE = "omp-lazy-rules-context"
export const CATALOG_CUSTOM_TYPE = "omp-lazy-catalog-context"

type ActivePacket = {
  readonly compiled: CompiledTaskPacket
  readonly message: TaskPacketMessage
}

type InjectionContent = {
  readonly rules: string | null
  readonly catalog: string | null
}

function hasCustomType(msg: AgentMessage): msg is AgentMessage & { customType: string } {
  return "customType" in msg
}

function isJobStatusOnly(details: unknown): boolean {
  const decoded = decodeJobResult(details)
  return (
    decoded.ok &&
    decoded.value.jobs.every((job) => job.resultText === undefined && job.errorText === undefined)
  )
}

function isStatusOnlyResult(toolName: string, details: unknown): boolean {
  if (toolName === "job") return isJobStatusOnly(details)
  if (toolName === "irc") return decodeIrcResult(details).ok
  if (toolName !== "hub") return false
  return (
    isHubWaitStatusOnlyResult(details) || isJobStatusOnly(details) || decodeIrcResult(details).ok
  )
}

export class ProductRuntimeObserver {
  readonly #active = new Map<string, ActivePacket>()
  readonly #injection = new Map<string, InjectionContent>()
  readonly #retrieval = new RetrievalBudgetGuard()
  readonly #modelCalls = new ModelCallObserver()

  activate(sessionId: string, result: StepContextCompileResult | null): void {
    if (result === null || !result.ok) {
      this.#active.delete(sessionId)
      this.#retrieval.clear(sessionId)
      return
    }
    this.#active.set(sessionId, { compiled: result.compiled, message: result.message })
    this.#retrieval.activate(sessionId, result.compiled)
  }

  /**
   * Sets the rules and catalog content to inject into the context for a session.
   * Content is validated against per-section byte budgets at injection time.
   */
  setInjectionContent(
    sessionId: string,
    content: { rules: string | null; catalog: string | null },
  ): void {
    this.#injection.set(sessionId, { rules: content.rules, catalog: content.catalog })
  }

  clear(sessionId: string): void {
    this.#active.delete(sessionId)
    this.#injection.delete(sessionId)
    this.#retrieval.clear(sessionId)
    this.#modelCalls.clear(sessionId)
  }

  context(input: {
    readonly sessionId: string
    readonly messages: readonly AgentMessage[]
    readonly model: Model | undefined
    readonly timestamp: number
  }): ContextEventResult | undefined {
    const active = this.#active.get(input.sessionId)
    if (active !== undefined && input.model !== undefined) {
      this.#modelCalls.begin(input.sessionId, active.compiled.packetHash, input.model)
    }

    // Step 1: compact step context (removes stale task packets, adds current)
    const afterPacket = compactStepContext(input.messages, active?.message ?? null, input.timestamp)

    // Step 2: filter stale rules/catalog messages from the array
    const filtered = afterPacket.filter(
      (msg) =>
        !(
          hasCustomType(msg) &&
          (msg.customType === RULES_CUSTOM_TYPE || msg.customType === CATALOG_CUSTOM_TYPE)
        ),
    )

    // Step 3: inject fresh rules and catalog if configured
    const injection = this.#injection.get(input.sessionId)
    const messages = injectRulesAndCatalog(filtered, injection ?? null)

    // Step 4: determine if messages changed
    return messages.length === input.messages.length &&
      messages.every((message, index) => message === input.messages[index])
      ? undefined
      : { messages }
  }

  toolCall(sessionId: string, toolCallId: string): ToolCallEventResult | undefined {
    return this.#retrieval.authorize(sessionId, toolCallId)
  }

  toolResult(input: {
    readonly sessionId: string
    readonly toolCallId: string
    readonly toolName: string
    readonly content: readonly MeteredResultContent[]
    readonly details: unknown
  }): ToolResultEventResult | undefined {
    const observed = this.#retrieval.observe({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      statusOnly: isStatusOnlyResult(input.toolName, input.details),
      content: input.content,
    })
    return observed.kind === "refused"
      ? { ...observed.replacement, content: [...observed.replacement.content] }
      : undefined
  }

  providerResponse(sessionId: string, event: AfterProviderResponseEvent): void {
    this.#modelCalls.observeResponse(sessionId, { status: event.status, headers: event.headers })
  }

  retryStarted(sessionId: string, event: AutoRetryStartEvent): void {
    this.#modelCalls.retryStarted(sessionId, event)
  }

  retrievalSnapshot(sessionId: string): RetrievalBudgetSnapshot | null {
    return this.#retrieval.snapshot(sessionId)
  }

  modelCallSnapshot(sessionId: string): ModelCallSnapshot | null {
    return this.#modelCalls.snapshot(sessionId)
  }
}

/**
 * Injects catalog and rules custom messages into the filtered messages array.
 *
 * Priority order (highest to lowest):
 * 1. Latest user turn (already in messages, stays in place)
 * 2. Active directive (injected by before_agent_start, already in messages if present)
 * 3. Catalog (injected here, after user messages)
 * 4. Rules (injected here, after catalog)
 * 5. Task packet (already appended at end by compactStepContext)
 *
 * Each section is validated against its byte budget. Over-budget sections are
 * dropped entirely (never partial).
 */
function injectRulesAndCatalog(
  messages: AgentMessage[],
  injection: InjectionContent | null,
): AgentMessage[] {
  if (injection === null) return messages
  const { rules, catalog } = injection
  if (rules === null && catalog === null) return messages

  // Validate catalog against its budget
  let validCatalog: string | null = null
  if (catalog !== null) {
    const catalogBytes = Buffer.byteLength(catalog, "utf8")
    if (catalogBytes <= CATALOG_BUDGET_BYTES) {
      validCatalog = catalog
    }
    // Over-budget: dropped entirely
  }

  // Validate rules against their budget
  let validRules: string | null = null
  if (rules !== null) {
    const rulesBytes = Buffer.byteLength(rules, "utf8")
    if (rulesBytes <= RULES_BUDGET_BYTES) {
      validRules = rules
    }
    // Over-budget: dropped entirely
  }

  if (validCatalog === null && validRules === null) return messages

  // Find the insertion point: after the last user/assistant message but before the task packet.
  // The task packet (if any) is always at the end (appended by compactStepContext).
  // We insert catalog then rules just before the task packet.
  const result = [...messages]
  const lastIdx = result.length - 1
  const lastMsg = lastIdx >= 0 ? result[lastIdx] : undefined
  const hasPacket =
    lastMsg !== undefined &&
    hasCustomType(lastMsg) &&
    lastMsg.customType === TASK_PACKET_CUSTOM_TYPE
  const insertAt = hasPacket ? lastIdx : result.length

  // Insert in priority order: catalog first (higher priority), then rules
  const toInsert: AgentMessage[] = []
  if (validCatalog !== null) {
    toInsert.push({
      role: "custom",
      customType: CATALOG_CUSTOM_TYPE,
      content: validCatalog,
      display: false,
      timestamp: Date.now(),
    } as AgentMessage)
  }
  if (validRules !== null) {
    toInsert.push({
      role: "custom",
      customType: RULES_CUSTOM_TYPE,
      content: validRules,
      display: false,
      timestamp: Date.now(),
    } as AgentMessage)
  }

  result.splice(insertAt, 0, ...toInsert)
  return result
}

export function registerProductRuntimeObservers(
  api: Pick<ExtensionAPI, "on">,
  observer: ProductRuntimeObserver,
  statusLine?: StatusLinePublisher,
): void {
  api.on("context", (event, context) =>
    observer.context({
      sessionId: context.sessionManager.getSessionId(),
      messages: event.messages,
      model: context.model,
      timestamp: Date.now(),
    }),
  )
  api.on("tool_call", (event, context) => {
    if (statusLine !== undefined) {
      statusLine.setWorking(context, `omp-lazy: dispatching ${event.toolName}`)
    }
    return observer.toolCall(context.sessionManager.getSessionId(), event.toolCallId)
  })
  api.on("tool_result", (event, context) => {
    if (statusLine !== undefined) {
      statusLine.setWorking(context, "omp-lazy: processing result")
    }
    return observer.toolResult({
      sessionId: context.sessionManager.getSessionId(),
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      content: event.content,
      details: event.details,
    })
  })
  api.on("after_provider_response", (event, context) => {
    observer.providerResponse(context.sessionManager.getSessionId(), event)
  })
  api.on("auto_retry_start", (event, context) => {
    observer.retryStarted(context.sessionManager.getSessionId(), event)
  })
  api.on("session_shutdown", (_event, context) => {
    observer.clear(context.sessionManager.getSessionId())
    if (statusLine !== undefined) {
      statusLine.clear(context)
    }
  })
}
