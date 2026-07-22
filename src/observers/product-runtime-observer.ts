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
import type { CompiledTaskPacket } from "../contracts/task-packet"
import {
  type MeteredResultContent,
  RetrievalBudgetGuard,
  type RetrievalBudgetSnapshot,
} from "../gates/retrieval-budget-guard"
import {
  compactStepContext,
  type StepContextCompileResult,
  type TaskPacketMessage,
} from "../workflows/task-packet-compiler"
import { ModelCallObserver, type ModelCallSnapshot } from "./model-call-observer"

const STATUS_ONLY_TOOLS = new Set(["hub", "irc", "job"])

type ActivePacket = {
  readonly compiled: CompiledTaskPacket
  readonly message: TaskPacketMessage
}

export class ProductRuntimeObserver {
  readonly #active = new Map<string, ActivePacket>()
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

  clear(sessionId: string): void {
    this.#active.delete(sessionId)
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
    const messages = compactStepContext(input.messages, active?.message ?? null, input.timestamp)
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
  }): ToolResultEventResult | undefined {
    const observed = this.#retrieval.observe({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      statusOnly: STATUS_ONLY_TOOLS.has(input.toolName),
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

export function registerProductRuntimeObservers(
  api: Pick<ExtensionAPI, "on">,
  observer: ProductRuntimeObserver,
): void {
  api.on("context", (event, context) =>
    observer.context({
      sessionId: context.sessionManager.getSessionId(),
      messages: event.messages,
      model: context.model,
      timestamp: Date.now(),
    }),
  )
  api.on("tool_call", (event, context) =>
    observer.toolCall(context.sessionManager.getSessionId(), event.toolCallId),
  )
  api.on("tool_result", (event, context) =>
    observer.toolResult({
      sessionId: context.sessionManager.getSessionId(),
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      content: event.content,
    }),
  )
  api.on("after_provider_response", (event, context) => {
    observer.providerResponse(context.sessionManager.getSessionId(), event)
  })
  api.on("auto_retry_start", (event, context) => {
    observer.retryStarted(context.sessionManager.getSessionId(), event)
  })
  api.on("session_shutdown", (_event, context) => {
    observer.clear(context.sessionManager.getSessionId())
  })
}
