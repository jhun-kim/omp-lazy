import type { UlwLoopRun } from "../state/domain"

export function evaluateUlwContinuation(
  _run: UlwLoopRun,
):
  | { readonly ok: true; readonly goalId: string }
  | { readonly ok: false; readonly code: "not_active" | "unmet_criteria" | "no_active_goal" } {
  const allCriteriaPass = _run.payload.goals.every((goal) =>
    goal.criteria.every((criterion) => criterion.status === "pass"),
  )
  if (_run.payload.status === "completed" && !allCriteriaPass) {
    return { ok: false, code: "unmet_criteria" }
  }
  if (_run.payload.status !== "active") return { ok: false, code: "not_active" }
  const goal = _run.payload.goals.find((candidate) => candidate.id === _run.payload.activeGoalId)
  return goal === undefined ? { ok: false, code: "no_active_goal" } : { ok: true, goalId: goal.id }
}

export function startGoalCycle(
  _run: UlwLoopRun,
  _goalId: string,
):
  | { readonly ok: true; readonly run: UlwLoopRun }
  | { readonly ok: false; readonly code: "cycle_limit" | "goal_missing" } {
  const goal = _run.payload.goals.find((candidate) => candidate.id === _goalId)
  if (goal === undefined) return { ok: false, code: "goal_missing" }
  if (goal.cycleCount >= 5) return { ok: false, code: "cycle_limit" }
  const goals = _run.payload.goals.map((candidate) =>
    candidate.id === _goalId ? { ...candidate, cycleCount: candidate.cycleCount + 1 } : candidate,
  )
  return {
    ok: true,
    run: {
      ..._run,
      revision: _run.revision + 1,
      progressRevision: _run.progressRevision + 1,
      payload: { ..._run.payload, goals },
    },
  }
}

export function recordCriterionFailure(
  _run: UlwLoopRun,
  _failure: { readonly goalId: string; readonly criterionId: string; readonly fingerprint: string },
):
  | { readonly ok: true; readonly run: UlwLoopRun }
  | {
      readonly ok: false
      readonly code: "identical_failure_limit" | "goal_missing" | "criterion_missing"
    } {
  const goal = _run.payload.goals.find((candidate) => candidate.id === _failure.goalId)
  if (goal === undefined) return { ok: false, code: "goal_missing" }
  const criterion = goal.criteria.find((candidate) => candidate.id === _failure.criterionId)
  if (criterion === undefined) return { ok: false, code: "criterion_missing" }
  const repeated = criterion.identicalFailureFingerprint === _failure.fingerprint
  if (repeated && criterion.identicalFailureCount >= 3) {
    return { ok: false, code: "identical_failure_limit" }
  }
  const criteria = goal.criteria.map((candidate) =>
    candidate.id === _failure.criterionId
      ? {
          ...candidate,
          status: "fail" as const,
          identicalFailureFingerprint: _failure.fingerprint,
          identicalFailureCount: repeated ? candidate.identicalFailureCount + 1 : 1,
        }
      : candidate,
  )
  const goals = _run.payload.goals.map((candidate) =>
    candidate.id === _failure.goalId ? { ...candidate, criteria } : candidate,
  )
  return {
    ok: true,
    run: {
      ..._run,
      revision: _run.revision + 1,
      progressRevision: _run.progressRevision + 1,
      payload: { ..._run.payload, goals },
    },
  }
}
