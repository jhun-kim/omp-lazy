import type { StartWorkRun } from "../state/domain"
import type { PlanSnapshot } from "./start-work-plan"

export function evaluateStartWorkContinuation(
  _run: StartWorkRun,
  _observed: PlanSnapshot,
):
  | { readonly ok: true; readonly nextTaskId: string }
  | { readonly ok: false; readonly code: "not_active" | "plan_identity_mismatch" | "complete" } {
  if (_run.payload.status !== "active") return { ok: false, code: "not_active" }
  if (
    _run.payload.plan.taskFingerprint !== _observed.fingerprint ||
    _run.payload.plan.taskIds.length !== _observed.taskIds.length ||
    _run.payload.plan.taskIds.some((taskId, index) => taskId !== _observed.taskIds[index])
  ) {
    return { ok: false, code: "plan_identity_mismatch" }
  }
  const nextTaskId = _observed.remainingTaskIds[0]
  return nextTaskId === undefined ? { ok: false, code: "complete" } : { ok: true, nextTaskId }
}
