import { recordCriterionFailure, startGoalCycle } from "../workflows/ulw-loop-contract"
import { reduceWorkflowControl } from "../workflows/workflow-control"
import type { ActiveIndex, ActiveIndexEntry, AnyRun, PersistedStateEvent } from "./domain"
import type { ReceiptAuthority } from "./receipt-authority"
import { reduceRuntimeProgress } from "./runtime-progress-transition"

export type TransitionErrorCode =
  | "index_revision_conflict"
  | "run_revision_conflict"
  | "owner_conflict"
  | "epoch_conflict"
  | "stale_revision"
  | "owner_mismatch"
  | "owner_epoch_mismatch"
  | "stale_head"
  | "task_scope_mismatch"
  | "invalid_mutation"

export type PreparedTransition = {
  readonly run: AnyRun
  readonly index: ActiveIndex
}

function controlRun(
  run: AnyRun,
  event: PersistedStateEvent,
  authority: ReceiptAuthority | null,
): AnyRun | null {
  const mutation = event.mutation
  if (
    event.schemaVersion === 2 &&
    event.legacyHeadUnbound &&
    (mutation.kind === "goal_cycle_started" || mutation.kind === "criterion_failure_recorded")
  ) {
    return run
  }
  switch (mutation.kind) {
    case "run_created":
      return null
    case "workflow_controlled": {
      const command = {
        kind: mutation.control,
        sessionId: run.owner.sessionId,
        expectedEpoch: run.owner.epoch,
      } as const
      const result =
        run.workflow === "start_work"
          ? reduceWorkflowControl(run, command)
          : reduceWorkflowControl(run, command)
      return result.ok ? result.run : null
    }
    case "owner_adopted": {
      const command = {
        kind: "adopt",
        sessionId: mutation.sessionId,
        expectedEpoch: run.owner.epoch,
      } as const
      const result =
        run.workflow === "start_work"
          ? reduceWorkflowControl(run, command)
          : reduceWorkflowControl(run, command)
      return result.ok ? result.run : null
    }
    case "plan_reconciled":
      if (run.workflow !== "start_work") return null
      {
        const result = reduceWorkflowControl(run, {
          kind: "reconcile_plan",
          sessionId: run.owner.sessionId,
          expectedEpoch: run.owner.epoch,
          plan: {
            taskIds: mutation.taskIds,
            remainingTaskIds: mutation.remainingTaskIds ?? mutation.taskIds,
            fingerprint: mutation.taskFingerprint,
          },
        })
        return result.ok ? result.run : null
      }
    case "workflow_steered":
      if (run.workflow !== "ulw_loop" || run.payload.activeGoalId === null) return null
      {
        const existing = new Set(
          run.payload.goals.flatMap((goal) => goal.criteria.map(({ id }) => id)),
        )
        if (mutation.criteria.some(({ id }) => existing.has(id))) return null
        const goals = run.payload.goals.map((goal) =>
          goal.id === run.payload.activeGoalId
            ? {
                ...goal,
                criteria: [
                  ...goal.criteria,
                  ...mutation.criteria.map((criterion) => ({
                    ...criterion,
                    status: "pending" as const,
                    identicalFailureFingerprint: null,
                    identicalFailureCount: 0,
                    evidenceRef: null,
                    captureRevision: null,
                    captureCommit: null,
                  })),
                ],
              }
            : goal,
        )
        return {
          ...run,
          revision: run.revision + 1,
          payload: {
            ...run.payload,
            ...(mutation.annotation === undefined ? {} : { annotation: mutation.annotation }),
            goals,
          },
        }
      }
    case "criterion_settled":
    case "task_evidence_accepted":
    case "workflow_terminal":
    case "continuation_attempted":
    case "continuation_stuck":
      return reduceRuntimeProgress(run, event, authority)
    case "goal_cycle_started":
      if (run.workflow !== "ulw_loop") return null
      {
        const result = startGoalCycle(run, mutation.goalId)
        return result.ok ? result.run : null
      }
    case "criterion_failure_recorded":
      if (run.workflow !== "ulw_loop") return null
      {
        const result = recordCriterionFailure(run, {
          goalId: mutation.goalId,
          criterionId: mutation.criterionId,
          fingerprint: mutation.fingerprint,
        })
        return result.ok ? result.run : null
      }
    default:
      return mutation satisfies never
  }
}

function statusHint(run: AnyRun): ActiveIndexEntry["statusHint"] | null {
  const status = run.payload.status
  switch (status) {
    case "active":
    case "paused":
    case "stuck":
      return status
    case "blocked":
    case "needs_user_decision":
    case "review_blocked":
      return "blocked"
    case "completed":
    case "cancelled":
    case "failed":
    case "abandoned":
      return null
    default:
      return status satisfies never
  }
}

export function deriveIndex(index: ActiveIndex, run: AnyRun, sequence: number): ActiveIndex {
  const hint = statusHint(run)
  const retained = index.entries.filter((entry) => entry.runId !== run.runId)
  const entries: readonly ActiveIndexEntry[] =
    hint === null
      ? retained
      : [
          ...retained,
          {
            workflow: run.workflow,
            sessionId: run.owner.sessionId,
            runId: run.runId,
            ownerEpoch: run.owner.epoch,
            runRevision: run.revision,
            transactionRevision: sequence,
            statusHint: hint,
          },
        ]
  return index.schemaVersion === 2
    ? { schemaVersion: 2, migrationRevision: index.migrationRevision, revision: sequence, entries }
    : { schemaVersion: 1, revision: sequence, entries }
}

export function prepareTransition(
  index: ActiveIndex,
  current: AnyRun | null,
  event: PersistedStateEvent,
  authority: ReceiptAuthority | null = null,
): PreparedTransition | { readonly code: TransitionErrorCode } {
  if (event.expected.indexRevision !== index.revision) {
    return { code: event.schemaVersion === 2 ? "stale_revision" : "index_revision_conflict" }
  }
  if (event.sequence !== index.revision + 1) return { code: "invalid_mutation" }
  let next: AnyRun | null
  if (event.mutation.kind === "run_created") {
    if (current !== null || event.expected.runRevision !== null)
      return { code: "run_revision_conflict" }
    if (event.expected.ownerSessionId !== null || event.expected.ownerEpoch !== null) {
      return { code: "owner_conflict" }
    }
    next = event.mutation.run
  } else {
    if (current === null) return { code: "run_revision_conflict" }
    if (current.revision !== event.expected.runRevision) {
      return { code: event.schemaVersion === 2 ? "stale_revision" : "run_revision_conflict" }
    }
    if (current.owner.sessionId !== event.expected.ownerSessionId) {
      return { code: event.schemaVersion === 2 ? "owner_mismatch" : "owner_conflict" }
    }
    if (current.owner.epoch !== event.expected.ownerEpoch) {
      return { code: event.schemaVersion === 2 ? "owner_epoch_mismatch" : "epoch_conflict" }
    }
    if (event.schemaVersion === 2) {
      if (
        event.expected.expectedHead !== null &&
        (current.schemaVersion !== 2 || current.expectedHead !== event.expected.expectedHead)
      ) {
        return { code: "stale_head" }
      }
      const taskScoped =
        event.kind === "plan_reconciled" ||
        event.kind === "workflow_steered" ||
        event.kind === "criterion_settled" ||
        event.kind === "task_evidence_accepted" ||
        event.kind === "workflow_terminal" ||
        event.kind === "goal_cycle_started" ||
        event.kind === "criterion_failure_recorded"
      if (taskScoped !== (event.expected.taskGeneration !== null)) {
        return { code: "task_scope_mismatch" }
      }
    }
    next = controlRun(current, event, authority)
  }
  if (next === null || next.runId !== event.runId || next.workflow !== event.workflow) {
    return { code: "invalid_mutation" }
  }
  const published = { ...next, transactionRevision: event.sequence }
  return {
    run: published,
    index: deriveIndex(index, published, event.sequence),
  }
}
