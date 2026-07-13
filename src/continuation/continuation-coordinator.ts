import { validateActiveIndex } from "../state/active-index"
import type {
  ActiveIndex,
  ActiveIndexEntry,
  AnyRun,
  StateEvent,
  Uuid,
  WorkflowKind,
} from "../state/domain"
import { evaluateStartWorkContinuation } from "../workflows/start-work-contract"
import type { PlanSnapshot } from "../workflows/start-work-plan"
import { evaluateUlwContinuation } from "../workflows/ulw-loop-contract"
import type { DeadlineFence } from "./deadline-fence"

export type PlanObservation = {
  readonly runId: Uuid
  readonly snapshot: PlanSnapshot
}

export type ContinuationDecision =
  | { readonly kind: "quiet" }
  | {
      readonly kind: "continue"
      readonly run: AnyRun
      readonly additionalContext: string
      readonly mutation: StateEvent["mutation"]
    }
  | {
      readonly kind: "stuck"
      readonly run: AnyRun
      readonly mutation: StateEvent["mutation"]
    }

export type ContinuationSnapshot = {
  readonly index: ActiveIndex
  readonly runs: readonly AnyRun[]
  readonly plans: readonly PlanObservation[]
}

export function decideContinuation(_request: {
  readonly sessionId: string
  readonly leafId: string
  readonly snapshot: ContinuationSnapshot
}): ContinuationDecision {
  if (!validateActiveIndex(_request.snapshot.index).ok) return { kind: "quiet" }
  const start = resolveWorkflow(_request.snapshot, "start_work", _request.sessionId)
  const loop = resolveWorkflow(_request.snapshot, "ulw_loop", _request.sessionId)
  if (start.kind === "conflict" || loop.kind === "conflict") return { kind: "quiet" }
  if (start.kind === "found") {
    if (start.run.workflow !== "start_work") return { kind: "quiet" }
    if (start.run.continuation.lastProcessedLeafId === _request.leafId) return { kind: "quiet" }
    const observed = _request.snapshot.plans.find((plan) => plan.runId === start.run.runId)
    if (observed !== undefined) {
      const eligibility = evaluateStartWorkContinuation(start.run, observed.snapshot)
      if (eligibility.ok) {
        return {
          kind: "continue",
          run: start.run,
          additionalContext:
            "Continue the authoritative start-work run. Re-read its contained plan and execute the next pending task under the workflow contract.",
          mutation: {
            kind: "continuation_attempted",
            leafId: _request.leafId,
            progressRevision: start.run.progressRevision,
          },
        }
      }
    }
  }
  if (loop.kind !== "found" || loop.run.workflow !== "ulw_loop") return { kind: "quiet" }
  if (loop.run.continuation.lastProcessedLeafId === _request.leafId) return { kind: "quiet" }
  const eligibility = evaluateUlwContinuation(loop.run)
  if (!eligibility.ok) return { kind: "quiet" }
  const activeGoal = loop.run.payload.goals.find((goal) => goal.id === eligibility.goalId)
  if (activeGoal?.status !== "pending" && activeGoal?.status !== "in_progress") {
    return { kind: "quiet" }
  }
  const unchanged =
    loop.run.continuation.progressRevisionSeen === loop.run.progressRevision &&
    loop.run.continuation.noProgressAttempts >= 2
  return unchanged
    ? {
        kind: "stuck",
        run: loop.run,
        mutation: { kind: "continuation_stuck", leafId: _request.leafId },
      }
    : {
        kind: "continue",
        run: loop.run,
        additionalContext:
          "Continue the authoritative ULW loop run. Re-read its persisted goal and criteria under the workflow contract.",
        mutation: {
          kind: "continuation_attempted",
          leafId: _request.leafId,
          progressRevision: loop.run.progressRevision,
        },
      }
}

type ResolvedWorkflow =
  | { readonly kind: "absent" }
  | { readonly kind: "conflict" }
  | { readonly kind: "found"; readonly run: AnyRun }

function hintMatches(entry: ActiveIndexEntry, run: AnyRun): boolean {
  const status = run.payload.status
  switch (status) {
    case "active":
    case "paused":
    case "stuck":
      return entry.statusHint === status
    case "blocked":
    case "needs_user_decision":
    case "review_blocked":
      return entry.statusHint === "blocked"
    case "completed":
    case "cancelled":
    case "failed":
    case "abandoned":
      return false
    default:
      return status satisfies never
  }
}

function resolveWorkflow(
  snapshot: ContinuationSnapshot,
  workflow: WorkflowKind,
  sessionId: string,
): ResolvedWorkflow {
  const entry = snapshot.index.entries.find(
    (candidate) => candidate.workflow === workflow && candidate.sessionId === sessionId,
  )
  if (entry === undefined) return { kind: "absent" }
  const run = snapshot.runs.find((candidate) => candidate.runId === entry.runId)
  if (run === undefined) return { kind: "conflict" }
  if (
    run.workflow !== entry.workflow ||
    run.owner.sessionId !== entry.sessionId ||
    run.owner.epoch !== entry.ownerEpoch ||
    run.revision !== entry.runRevision ||
    run.transactionRevision !== entry.transactionRevision ||
    !hintMatches(entry, run)
  ) {
    return { kind: "conflict" }
  }
  return { kind: "found", run }
}

export type CoordinatorRequest = {
  readonly cwd: string
  readonly diagnosticTurnId: number
  readonly fence: DeadlineFence
  readonly leafId: string
  readonly sessionId: string
}

export type CoordinatorResult =
  | { readonly kind: "quiet" }
  | { readonly kind: "continue"; readonly additionalContext: string }

export interface ContinuationCoordinatorPort {
  handle(request: CoordinatorRequest): Promise<CoordinatorResult>
}
