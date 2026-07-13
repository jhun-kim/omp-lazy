import { type AgentId, type JobId, runtimeIdValue, type ToolCallId } from "../contracts/agent-ids"
import type {
  TaskAuthorizationFact,
  TaskFact,
  TaskIdentityFact,
  TaskReceiptFact,
  TaskReservationFact,
} from "./task-ledger-codec"
import type { TaskRunScope } from "./task-sidecar-store"

export type RuntimeIdentityRecord = {
  readonly toolCallId: ToolCallId
  readonly itemIndex: number
  readonly requestedName: string | null
  readonly agentType: string | null
  readonly actualAgentId: AgentId
  readonly actualJobId: JobId | null
  readonly parentActualAgentId: AgentId | null
}

export type AsyncCapabilityRecord =
  | { readonly status: "unknown" }
  | { readonly status: "proven" | "blocked"; readonly reason: string }

export function taskFacts(scope: TaskRunScope): readonly TaskFact[] {
  return scope.ledger.entries.map((entry) => entry.fact)
}

export function taskGeneration(scope: TaskRunScope): number {
  return (
    scope.ledger.entries.findLast(
      (entry) => entry.fact.kind === "task_reserved" || entry.fact.kind === "task_identities_bound",
    )?.sequence ?? 0
  )
}

export function taskReservations(scope: TaskRunScope): readonly TaskReservationFact[] {
  return taskFacts(scope).flatMap((fact) => (fact.kind === "task_reserved" ? [fact] : []))
}

export function taskReservation(
  scope: TaskRunScope,
  toolCallId: ToolCallId,
): TaskReservationFact | undefined {
  return taskReservations(scope).find((fact) => fact.toolCallId === toolCallId)
}

export function taskIdentityFacts(scope: TaskRunScope): readonly TaskIdentityFact[] {
  return taskFacts(scope).flatMap((fact) => (fact.kind === "task_identities_bound" ? [fact] : []))
}

export function taskAuthorization(
  scope: TaskRunScope,
  toolCallId: ToolCallId,
): TaskAuthorizationFact | undefined {
  return scope.ledger.entries.find(
    (entry) =>
      entry.ownerSessionId === scope.run.owner.sessionId &&
      entry.ownerEpoch === scope.run.owner.epoch &&
      entry.fact.kind === "task_control_authorized" &&
      entry.fact.toolCallId === toolCallId,
  )?.fact as TaskAuthorizationFact | undefined
}

export function taskReceipts(scope: TaskRunScope): readonly TaskReceiptFact[] {
  return taskFacts(scope).flatMap((fact) => (fact.kind === "task_receipt_observed" ? [fact] : []))
}

export function runtimeIdentities(scope: TaskRunScope): readonly RuntimeIdentityRecord[] {
  const reservations = new Map(taskReservations(scope).map((fact) => [fact.toolCallId, fact]))
  const returnedJobs = new Map(
    taskReceipts(scope).flatMap((fact) =>
      fact.receipt.kind === "job"
        ? [[runtimeIdValue(fact.receipt.jobId), fact.receipt.jobId] as const]
        : [],
    ),
  )
  return taskIdentityFacts(scope).flatMap((identity) => {
    const reservation = reservations.get(identity.toolCallId)
    if (reservation === undefined) return []
    return identity.bindings.flatMap((binding) => {
      const request = reservation.requests[binding.itemIndex]
      if (request === undefined) return []
      return [
        {
          toolCallId: identity.toolCallId,
          itemIndex: binding.itemIndex,
          requestedName: request.requestedName,
          agentType: request.agentType,
          actualAgentId: binding.actualAgentId,
          actualJobId:
            binding.actualJobId ?? returnedJobs.get(runtimeIdValue(binding.actualAgentId)) ?? null,
          parentActualAgentId: null,
        },
      ]
    })
  })
}

export function runtimeCapability(scope: TaskRunScope): AsyncCapabilityRecord {
  const generation = taskGeneration(scope)
  const latest = taskFacts(scope).findLast(
    (fact) => fact.kind === "async_capability_observed" && fact.taskGeneration === generation,
  )
  return latest?.kind === "async_capability_observed"
    ? { status: latest.status, reason: latest.reason }
    : { status: "unknown" }
}
