import type { AnyRun, PersistedStateEvent } from "./domain"
import {
  currentAcceptance,
  exhaustedTaskId,
  type ReceiptAuthority,
  startCompletionAcceptanceIds,
} from "./receipt-authority"

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function setRunStatus(run: AnyRun, status: "failed" | "stuck"): AnyRun {
  switch (run.workflow) {
    case "start_work":
      return { ...run, revision: run.revision + 1, payload: { ...run.payload, status } }
    case "ulw_loop":
      return { ...run, revision: run.revision + 1, payload: { ...run.payload, status } }
    default:
      return run satisfies never
  }
}

function settleCriterion(
  run: AnyRun,
  event: PersistedStateEvent,
  authority: ReceiptAuthority | null,
): AnyRun | null {
  if (run.workflow !== "ulw_loop" || event.mutation.kind !== "criterion_settled") return null
  if (event.schemaVersion === 2 && event.legacyHeadUnbound) return run
  if (event.schemaVersion !== 2 || authority === null) return null
  const mutation = event.mutation
  const accepted = currentAcceptance(run, authority, mutation.criterionId)
  if (
    mutation.acceptanceId === undefined ||
    accepted?.idempotencyKey !== mutation.acceptanceId ||
    accepted.taskGeneration !== event.expected.taskGeneration ||
    accepted.runRevision !== mutation.captureRevision ||
    accepted.captureCommit !== mutation.captureCommit
  ) {
    return null
  }
  const goal = run.payload.goals.find(({ id }) => id === mutation.goalId)
  const criterion = goal?.criteria.find(({ id }) => id === mutation.criterionId)
  if (goal === undefined || criterion === undefined || criterion.status === "pass") return null
  const goals = run.payload.goals.map((candidate) => {
    if (candidate.id !== mutation.goalId) return candidate
    const criteria = candidate.criteria.map((item) =>
      item.id === mutation.criterionId
        ? {
            ...item,
            status: "pass" as const,
            evidenceRef: mutation.evidenceRef,
            captureRevision: mutation.captureRevision,
            captureCommit: mutation.captureCommit,
          }
        : item,
    )
    return {
      ...candidate,
      status: criteria.every(({ status }) => status === "pass")
        ? ("complete" as const)
        : candidate.status,
      criteria,
    }
  })
  const completed = goals.every((candidate) =>
    candidate.criteria.every(({ status }) => status === "pass"),
  )
  return {
    ...run,
    revision: run.revision + 1,
    progressRevision: run.progressRevision + 1,
    payload: {
      ...run.payload,
      activeGoalId: completed ? null : run.payload.activeGoalId,
      status: completed ? "completed" : run.payload.status,
      goals,
    },
  }
}

function acceptTaskEvidence(
  run: AnyRun,
  event: PersistedStateEvent,
  authority: ReceiptAuthority | null,
): AnyRun | null {
  if (run.workflow !== "start_work" || event.mutation.kind !== "task_evidence_accepted") {
    return null
  }
  if (event.schemaVersion !== 2 || event.legacyHeadUnbound || authority === null) return null
  const accepted = currentAcceptance(run, authority, event.mutation.taskId)
  if (
    accepted?.idempotencyKey !== event.mutation.acceptanceId ||
    accepted.taskGeneration !== event.expected.taskGeneration
  ) {
    return null
  }
  return { ...run, revision: run.revision + 1, progressRevision: run.progressRevision + 1 }
}

function terminalRun(
  run: AnyRun,
  event: PersistedStateEvent,
  authority: ReceiptAuthority | null,
): AnyRun | null {
  if (event.mutation.kind !== "workflow_terminal") return null
  if (event.schemaVersion !== 2 || event.legacyHeadUnbound || authority === null) return null
  if (event.expected.taskGeneration !== authority.taskGeneration) return null
  if (event.mutation.status === "failed") {
    if (
      event.mutation.taskId === undefined ||
      exhaustedTaskId(run, authority) !== event.mutation.taskId
    ) {
      return null
    }
    return setRunStatus(run, "failed")
  }
  if (run.workflow !== "start_work") return null
  const acceptanceIds = startCompletionAcceptanceIds(run, authority)
  if (
    acceptanceIds === null ||
    event.mutation.acceptanceIds === undefined ||
    !sameStrings(acceptanceIds, event.mutation.acceptanceIds)
  ) {
    return null
  }
  return {
    ...run,
    revision: run.revision + 1,
    progressRevision: run.progressRevision + 1,
    payload: { ...run.payload, status: "completed" },
  }
}

function attemptContinuation(run: AnyRun, event: PersistedStateEvent): AnyRun | null {
  if (event.mutation.kind !== "continuation_attempted") return null
  if (
    run.continuation.lastProcessedLeafId === event.mutation.leafId ||
    event.mutation.progressRevision !== run.progressRevision
  ) {
    return null
  }
  const progressChanged = run.continuation.progressRevisionSeen !== run.progressRevision
  return {
    ...run,
    revision: run.revision + 1,
    continuation: {
      lastProcessedLeafId: event.mutation.leafId,
      progressRevisionSeen: run.progressRevision,
      noProgressAttempts: progressChanged ? 1 : run.continuation.noProgressAttempts + 1,
      stuck: false,
    },
  }
}

function stopContinuation(run: AnyRun, event: PersistedStateEvent): AnyRun | null {
  if (event.mutation.kind !== "continuation_stuck") return null
  if (
    run.continuation.lastProcessedLeafId === event.mutation.leafId ||
    run.continuation.progressRevisionSeen !== run.progressRevision ||
    run.continuation.noProgressAttempts < 2
  ) {
    return null
  }
  const stopped = setRunStatus(run, "stuck")
  return {
    ...stopped,
    continuation: {
      ...stopped.continuation,
      lastProcessedLeafId: event.mutation.leafId,
      stuck: true,
    },
  }
}

export function reduceRuntimeProgress(
  run: AnyRun,
  event: PersistedStateEvent,
  authority: ReceiptAuthority | null,
): AnyRun | null {
  switch (event.mutation.kind) {
    case "criterion_settled":
      return settleCriterion(run, event, authority)
    case "task_evidence_accepted":
      return acceptTaskEvidence(run, event, authority)
    case "workflow_terminal":
      return terminalRun(run, event, authority)
    case "continuation_attempted":
      return attemptContinuation(run, event)
    case "continuation_stuck":
      return stopContinuation(run, event)
    default:
      return null
  }
}
