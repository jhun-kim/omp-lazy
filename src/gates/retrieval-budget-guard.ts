import {
  createRetrievalBudget,
  meterRetrievalResult,
  type RetrievalBudget,
  type RetrievalMeterResult,
} from "../contracts/retrieval-budget"
import type { CompiledTaskPacket } from "../contracts/task-packet"

type TextResultContent = { readonly type: "text"; readonly text: string }
type ImageResultContent = {
  readonly type: "image"
  readonly data: string
  readonly mimeType: string
}
export type MeteredResultContent = TextResultContent | ImageResultContent

type RetrievalRefusalCode = Extract<RetrievalMeterResult, { readonly ok: false }>["code"]

export type RetrievalObservation = {
  readonly toolCallId: string
  readonly deliveredBytes: number
  readonly outcome: "empty" | "status" | "delivered" | RetrievalRefusalCode
}

export type RetrievalBudgetSnapshot = {
  readonly packetHash: string
  readonly budget: RetrievalBudget
  readonly terminalCode: RetrievalRefusalCode | null
  readonly observations: readonly RetrievalObservation[]
}

export type RetrievalGuardResult =
  | { readonly kind: "quiet" }
  | { readonly kind: "metered"; readonly budget: RetrievalBudget }
  | {
      readonly kind: "refused"
      readonly code: RetrievalRefusalCode
      readonly replacement: {
        readonly content: readonly [{ readonly type: "text"; readonly text: string }]
        readonly details: {
          readonly version: 1
          readonly packetHash: string
          readonly code: RetrievalRefusalCode
        }
        readonly isError: true
      }
    }

type MutableRetrievalState = {
  readonly compiled: CompiledTaskPacket
  budget: RetrievalBudget
  terminalCode: RetrievalRefusalCode | null
  readonly pendingCallIds: Set<string>
  readonly seenCallIds: Set<string>
  readonly observations: RetrievalObservation[]
}

function resultContent(content: readonly MeteredResultContent[]): string {
  return content
    .map((part) => {
      switch (part.type) {
        case "text":
          return part.text
        case "image":
          return part.data
        default:
          return part satisfies never
      }
    })
    .join("")
}

function refusal(state: MutableRetrievalState, code: RetrievalRefusalCode): RetrievalGuardResult {
  return {
    kind: "refused",
    code,
    replacement: {
      content: [{ type: "text", text: `omp-lazy: ${code}` }],
      details: { version: 1, packetHash: state.compiled.packetHash, code },
      isError: true,
    },
  }
}

export class RetrievalBudgetGuard {
  readonly #states = new Map<string, MutableRetrievalState>()

  activate(sessionId: string, compiled: CompiledTaskPacket): void {
    const current = this.#states.get(sessionId)
    if (current?.compiled.packetHash === compiled.packetHash) return
    this.#states.set(sessionId, {
      compiled,
      budget: createRetrievalBudget(compiled.packet.tier),
      terminalCode: null,
      pendingCallIds: new Set(),
      seenCallIds: new Set(),
      observations: [],
    })
  }

  clear(sessionId: string): void {
    this.#states.delete(sessionId)
  }

  authorize(
    sessionId: string,
    toolCallId: string,
  ): { readonly block: true; readonly reason: string } | undefined {
    const state = this.#states.get(sessionId)
    if (state === undefined) return undefined
    if (state.terminalCode !== null) {
      return { block: true, reason: `omp-lazy: ${state.terminalCode}` }
    }
    if (state.seenCallIds.has(toolCallId)) {
      return { block: true, reason: "omp-lazy: duplicate_tool_call_id" }
    }
    const projectedCalls = state.budget.generalCalls + state.pendingCallIds.size + 1
    if (projectedCalls > state.compiled.packet.budgets.maxCalls) {
      state.terminalCode = "general_call_budget_exceeded"
      return { block: true, reason: "omp-lazy: general_call_budget_exceeded" }
    }
    state.seenCallIds.add(toolCallId)
    state.pendingCallIds.add(toolCallId)
    return undefined
  }

  observe(input: {
    readonly sessionId: string
    readonly toolCallId: string
    readonly statusOnly: boolean
    readonly content: readonly MeteredResultContent[]
  }): RetrievalGuardResult {
    const state = this.#states.get(input.sessionId)
    if (state === undefined) return { kind: "quiet" }
    if (state.terminalCode !== null) return refusal(state, state.terminalCode)
    if (!state.pendingCallIds.delete(input.toolCallId)) {
      return { kind: "quiet" }
    }

    const delivered = resultContent(input.content)
    const result = input.statusOnly
      ? { kind: "status" as const }
      : delivered.length === 0
        ? { kind: "empty" as const }
        : { kind: "delivered" as const, content: delivered }
    const metered = meterRetrievalResult(state.budget, result)
    const deliveredBytes = Buffer.byteLength(delivered, "utf8")
    state.observations.push({
      toolCallId: input.toolCallId,
      deliveredBytes,
      outcome: metered.ok ? result.kind : metered.code,
    })
    if (!metered.ok) {
      state.terminalCode = metered.code
      return refusal(state, metered.code)
    }
    state.budget = metered.budget
    return { kind: "metered", budget: metered.budget }
  }

  snapshot(sessionId: string): RetrievalBudgetSnapshot | null {
    const state = this.#states.get(sessionId)
    return state === undefined
      ? null
      : {
          packetHash: state.compiled.packetHash,
          budget: state.budget,
          terminalCode: state.terminalCode,
          observations: [...state.observations],
        }
  }
}
