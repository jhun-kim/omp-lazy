import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import {
  type RuntimeIdentityBinding,
  runtimeIdValue,
  ToolCallIdSchema,
} from "../contracts/agent-ids"
import {
  hubJobOperation,
  parseHubWaitControl,
  parseIrcControl,
  parseJobControl,
} from "../gates/task-control-parser"
import type { TaskEventLedger } from "../gates/task-event-ledger"
import type { ReceiptWriteStatus } from "../gates/task-receipt-writer"
import type { TaskLedgerTransaction } from "../gates/task-sidecar-store"
import { decodeIrcResult, isHubWaitMessageResult } from "./irc-result-codec"
import { decodeJobResult } from "./job-result-codec"
import { decodeTaskResult, type TaskResultDetails } from "./task-result-codec"

export type ToolResultObservation = {
  readonly toolName: string
  readonly toolCallId: string
  readonly input: Readonly<Record<string, unknown>>
  readonly details: unknown
  readonly isError: boolean
  readonly sessionId: string
}

export type ObservationResult =
  | { readonly kind: "quiet" }
  | { readonly kind: "recorded"; readonly capability: "pending" | "proven" | "blocked" }
  | { readonly kind: "blocked"; readonly reason: string }

export type TaskSurfaceCapability =
  | { readonly status: "surface_available" }
  | { readonly status: "blocked"; readonly reason: "task_or_hub_surface_missing" }

export function checkTaskSurfaces(activeTools: readonly string[]): TaskSurfaceCapability {
  const tools = new Set(activeTools)
  return tools.has("task") && tools.has("hub")
    ? { status: "surface_available" }
    : { status: "blocked", reason: "task_or_hub_surface_missing" }
}

export class ToolResultObserver {
  constructor(readonly ledger: TaskEventLedger) {}

  async observe(observation: ToolResultObservation): Promise<ObservationResult> {
    try {
      if (observation.toolName === "task") return this.#observeTask(observation)
      if (observation.toolName === "job") return this.#observeJob(observation)
      if (observation.toolName === "irc") return this.#observeIrc(observation)
      if (observation.toolName === "hub") return this.#observeHub(observation)
      return { kind: "quiet" }
    } catch (error) {
      if (error instanceof Error) return { kind: "blocked", reason: "task state conflict" }
      throw error
    }
  }

  async #observeHub(observation: ToolResultObservation): Promise<ObservationResult> {
    const operation = hubJobOperation(observation.input)
    const details = decodeJobResult(observation.details)
    if (details.ok) {
      if (operation === null || details.value.op !== operation) {
        return { kind: "blocked", reason: "invalid job result" }
      }
      return this.#observeJob(observation)
    }
    const wait = parseHubWaitControl(observation.input)
    if (wait.ok && isHubWaitMessageResult(observation.details)) return { kind: "quiet" }
    const irc = parseIrcControl(observation.input)
    if (!irc.ok || irc.kind === "passive") return { kind: "quiet" }
    return this.#observeIrc(observation)
  }

  async #observeTask(observation: ToolResultObservation): Promise<ObservationResult> {
    const toolCallId = ToolCallIdSchema.safeParse(observation.toolCallId)
    const details = decodeTaskResult(observation.details)
    if (!toolCallId.success || !details.ok || observation.isError) {
      return { kind: "blocked", reason: "invalid task result" }
    }
    const reservation = await this.ledger.reservation(observation.sessionId, toolCallId.data)
    if (reservation === undefined) {
      return { kind: "blocked", reason: "identity_mapping_incomplete" }
    }
    const bindings = this.#bindings(details.value, reservation.itemCount)
    if (bindings === null) {
      return { kind: "blocked", reason: "identity_mapping_incomplete" }
    }
    const bound = await this.ledger.bind(
      observation.sessionId,
      toolCallId.data,
      bindings,
      details.value.async !== undefined,
    )
    if (bound.kind !== "scope") return { kind: "blocked", reason: "identity commit conflict" }
    if (bound.value === "pending") return { kind: "recorded", capability: "pending" }
    if (bound.value === "blocked") return { kind: "recorded", capability: "blocked" }
    return {
      kind: "blocked",
      reason:
        bound.value === "missing_reservation"
          ? "identity_mapping_incomplete"
          : "identity commit conflict",
    }
  }

  #bindings(
    details: TaskResultDetails,
    itemCount: number,
  ): readonly RuntimeIdentityBinding[] | null {
    if (details.progress?.length !== itemCount) return null
    const ordered = [...details.progress].sort((left, right) => left.index - right.index)
    if (
      ordered.some((progress, index) => progress.index !== index) ||
      new Set(ordered.map((progress) => progress.id)).size !== ordered.length
    ) {
      return null
    }
    return ordered.map((progress) => ({
      itemIndex: progress.index,
      actualAgentId: progress.id,
      actualJobId:
        details.async !== undefined &&
        runtimeIdValue(details.async.jobId) === runtimeIdValue(progress.id)
          ? details.async.jobId
          : null,
    }))
  }

  async #observeJob(observation: ToolResultObservation): Promise<ObservationResult> {
    const toolCallId = ToolCallIdSchema.safeParse(observation.toolCallId)
    const control = parseJobControl(observation.input)
    const details = decodeJobResult(observation.details)
    if (!toolCallId.success || !control.ok || !details.ok || observation.isError) {
      return { kind: "blocked", reason: "invalid job result" }
    }
    const recorded =
      control.control === "job_cancel"
        ? await this.ledger.recordCancellation(
            observation.sessionId,
            toolCallId.data,
            control.inputKey,
            details.value.cancelled ?? [],
          )
        : await this.ledger.recordJobSnapshot(
            observation.sessionId,
            toolCallId.data,
            control.inputKey,
            details.value.jobs,
          )
    return this.#receiptResult(recorded, control.control === "job_snapshot")
  }

  async #observeIrc(observation: ToolResultObservation): Promise<ObservationResult> {
    const toolCallId = ToolCallIdSchema.safeParse(observation.toolCallId)
    const control = parseIrcControl(observation.input)
    const details = decodeIrcResult(observation.details)
    if (
      !toolCallId.success ||
      !control.ok ||
      control.kind !== "send" ||
      !details.ok ||
      observation.isError
    ) {
      return { kind: "blocked", reason: "invalid IRC receipt" }
    }
    const recorded = await this.ledger.recordIrcReceipts(
      observation.sessionId,
      toolCallId.data,
      control.inputKey,
      details.value.receipts ?? [],
    )
    return this.#receiptResult(recorded, false)
  }

  #receiptResult(
    result: TaskLedgerTransaction<ReceiptWriteStatus>,
    capabilityProof: boolean,
  ): ObservationResult {
    if (result.kind !== "scope") return { kind: "blocked", reason: "task state conflict" }
    if (result.value === "recorded") {
      return { kind: "recorded", capability: capabilityProof ? "proven" : "pending" }
    }
    if (result.value === "identity_mapping_incomplete") {
      return { kind: "recorded", capability: "blocked" }
    }
    if (result.value === "uncorrelated") {
      return { kind: "blocked", reason: "uncorrelated job result" }
    }
    if (result.value === "stale_generation") {
      return { kind: "blocked", reason: "stale task generation" }
    }
    return { kind: "blocked", reason: "receipt missing" }
  }
}

export function registerToolResultObserver(
  api: Pick<ExtensionAPI, "on">,
  observer: ToolResultObserver,
): void {
  api.on("tool_result", async (event, context) => {
    await observer.observe({
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      input: event.input,
      details: event.details,
      isError: event.isError,
      sessionId: context.sessionManager.getSessionId(),
    })
  })
}
