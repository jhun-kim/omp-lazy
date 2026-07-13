import type { RuntimeIdentityBinding, ToolCallId } from "../contracts/agent-ids"
import { runtimeIdValue } from "../contracts/agent-ids"
import type { TransactionStore } from "../state/transaction-store"
import type {
  TaskAuthorizationFact,
  TaskFact,
  TaskReceiptFact,
  TaskReservationFact,
} from "./task-ledger-codec"
import {
  type AsyncCapabilityRecord,
  type RuntimeIdentityRecord,
  runtimeCapability,
  runtimeIdentities,
  taskFacts,
  taskGeneration,
  taskIdentityFacts,
  taskReceipts,
  taskReservation,
  taskReservations,
} from "./task-ledger-view"
import {
  type ReceiptWriteStatus,
  recordCancellation,
  recordIrcReceipts,
  recordJobSnapshot,
  type TaskCancelReceipt,
  type TaskIrcReceipt,
  type TaskJobSnapshot,
} from "./task-receipt-writer"
import {
  type TaskLedgerTransaction,
  type TaskScopeResult,
  TaskSidecarStore,
} from "./task-sidecar-store"

export type ReserveStatus = "reserved" | "replayed" | "limit" | "fact_conflict"
export type BindingStatus = "pending" | "blocked" | "fact_conflict" | "missing_reservation"
export type AuthorizationStatus = "authorized" | "unowned" | "no_generation"

export type ControlAuthorization = {
  readonly toolCallId: ToolCallId
  readonly control: TaskAuthorizationFact["control"]
  readonly inputKey: string
  readonly targets: readonly string[]
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export class TaskEventLedger {
  readonly sidecar: TaskSidecarStore

  constructor(readonly store: TransactionStore) {
    this.sidecar = new TaskSidecarStore(store)
  }

  async resolve(sessionId: string): Promise<TaskScopeResult> {
    return this.sidecar.resolve(sessionId)
  }

  async reserve(
    sessionId: string,
    reservation: TaskReservationFact,
    maxFanOut: number,
  ): Promise<TaskLedgerTransaction<ReserveStatus>> {
    return this.sidecar.transact(sessionId, (scope) => {
      const existing = taskReservation(scope, reservation.toolCallId)
      if (existing !== undefined) {
        return {
          kind: "return",
          value: sameValue(existing, reservation) ? "replayed" : "fact_conflict",
        }
      }
      const reserved = taskReservations(scope).reduce((sum, fact) => sum + fact.itemCount, 0)
      const total = reserved + reservation.itemCount
      if (!Number.isSafeInteger(total) || total > maxFanOut) {
        return { kind: "return", value: "limit" }
      }
      return { kind: "append", facts: [reservation], value: "reserved" }
    })
  }

  async reservation(
    sessionId: string,
    toolCallId: ToolCallId,
  ): Promise<TaskReservationFact | undefined> {
    const scope = await this.resolve(sessionId)
    return scope.kind === "scope" ? taskReservation(scope.value, toolCallId) : undefined
  }

  async bind(
    sessionId: string,
    toolCallId: ToolCallId,
    bindings: readonly RuntimeIdentityBinding[],
    asyncAvailable: boolean,
  ): Promise<TaskLedgerTransaction<BindingStatus>> {
    return this.sidecar.transact(sessionId, (scope) => {
      const reservation = taskReservation(scope, toolCallId)
      if (reservation === undefined) return { kind: "return", value: "missing_reservation" }
      if (
        bindings.length !== reservation.itemCount ||
        bindings.some((binding, index) => binding.itemIndex !== index) ||
        new Set(bindings.map((binding) => runtimeIdValue(binding.actualAgentId))).size !==
          bindings.length
      ) {
        return { kind: "return", value: "fact_conflict" }
      }
      const fact: TaskFact = { kind: "task_identities_bound", toolCallId, bindings }
      const existing = taskIdentityFacts(scope).find(
        (candidate) => candidate.toolCallId === toolCallId,
      )
      if (existing !== undefined) {
        return {
          kind: "return",
          value: sameValue(existing, fact)
            ? asyncAvailable
              ? "pending"
              : "blocked"
            : "fact_conflict",
        }
      }
      const generation = scope.ledger.ledgerRevision + 1
      const facts: TaskFact[] = [fact]
      if (!asyncAvailable) {
        facts.push({
          kind: "async_capability_observed",
          toolCallId,
          taskGeneration: generation,
          status: "blocked",
          reason: "async_unavailable_or_inline",
        })
      }
      return { kind: "append", facts, value: asyncAvailable ? "pending" : "blocked" }
    })
  }

  async authorize(
    sessionId: string,
    authorization: ControlAuthorization,
  ): Promise<TaskLedgerTransaction<AuthorizationStatus>> {
    return this.sidecar.transact(sessionId, (scope) => {
      const generation = taskGeneration(scope)
      if (generation === 0) return { kind: "return", value: "no_generation" }
      const identities = runtimeIdentities(scope, generation)
      const owned = new Set(
        authorization.control === "irc_send" || authorization.control === "irc_target"
          ? identities.map((identity) => runtimeIdValue(identity.actualAgentId))
          : identities.flatMap((identity) =>
              identity.actualJobId === null ? [] : [runtimeIdValue(identity.actualJobId)],
            ),
      )
      if (authorization.targets.some((target) => !owned.has(target))) {
        return { kind: "return", value: "unowned" }
      }
      return {
        kind: "append",
        facts: [
          {
            kind: "task_control_authorized",
            ...authorization,
            taskGeneration: generation,
          },
        ],
        value: "authorized",
      }
    })
  }

  async recordJobSnapshot(
    sessionId: string,
    toolCallId: ToolCallId,
    inputKey: string,
    jobs: readonly TaskJobSnapshot[],
  ): Promise<TaskLedgerTransaction<ReceiptWriteStatus>> {
    return recordJobSnapshot(this.sidecar, sessionId, toolCallId, inputKey, jobs)
  }

  async recordCancellation(
    sessionId: string,
    toolCallId: ToolCallId,
    inputKey: string,
    cancelled: readonly TaskCancelReceipt[],
  ): Promise<TaskLedgerTransaction<ReceiptWriteStatus>> {
    return recordCancellation(this.sidecar, sessionId, toolCallId, inputKey, cancelled)
  }

  async recordIrcReceipts(
    sessionId: string,
    toolCallId: ToolCallId,
    inputKey: string,
    receipts: readonly TaskIrcReceipt[],
  ): Promise<TaskLedgerTransaction<ReceiptWriteStatus>> {
    return recordIrcReceipts(this.sidecar, sessionId, toolCallId, inputKey, receipts)
  }

  async reservations(sessionId: string): Promise<readonly TaskReservationFact[]> {
    const scope = await this.resolve(sessionId)
    return scope.kind === "scope" ? taskReservations(scope.value) : []
  }

  async identities(sessionId: string): Promise<readonly RuntimeIdentityRecord[]> {
    const scope = await this.resolve(sessionId)
    return scope.kind === "scope" ? runtimeIdentities(scope.value) : []
  }

  async receipts(sessionId: string): Promise<readonly TaskReceiptFact[]> {
    const scope = await this.resolve(sessionId)
    return scope.kind === "scope" ? taskReceipts(scope.value) : []
  }

  async capability(sessionId: string): Promise<AsyncCapabilityRecord> {
    const scope = await this.resolve(sessionId)
    return scope.kind === "scope" ? runtimeCapability(scope.value) : { status: "unknown" }
  }

  async ledgerRevision(sessionId: string): Promise<number | null> {
    const scope = await this.resolve(sessionId)
    return scope.kind === "scope" ? scope.value.ledger.ledgerRevision : null
  }

  async facts(sessionId: string): Promise<readonly TaskFact[]> {
    const scope = await this.resolve(sessionId)
    return scope.kind === "scope" ? taskFacts(scope.value) : []
  }
}
