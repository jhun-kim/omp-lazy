import type { AnyRun, StartWorkRun, UlwLoopRun } from "../state/domain"
import type { PlanSnapshot } from "./start-work-plan"

export type ControlCommand =
  | { readonly kind: "pause"; readonly sessionId: string; readonly expectedEpoch: number }
  | { readonly kind: "resume"; readonly sessionId: string; readonly expectedEpoch: number }
  | { readonly kind: "cancel"; readonly sessionId: string; readonly expectedEpoch: number }
  | { readonly kind: "adopt"; readonly sessionId: string; readonly expectedEpoch: number }
  | {
      readonly kind: "reconcile_plan"
      readonly sessionId: string
      readonly expectedEpoch: number
      readonly plan: PlanSnapshot
    }

type ControlError = "owner_mismatch" | "epoch_mismatch" | "terminal" | "invalid_transition"
type ControlResult<T extends AnyRun> =
  | { readonly ok: true; readonly run: T }
  | { readonly ok: false; readonly code: ControlError }

function precheck(run: AnyRun, command: ControlCommand): ControlResult<AnyRun> | null {
  if (command.kind !== "adopt" && run.owner.sessionId !== command.sessionId) {
    return { ok: false, code: "owner_mismatch" }
  }
  return run.owner.epoch === command.expectedEpoch ? null : { ok: false, code: "epoch_mismatch" }
}

function resetContinuation(run: AnyRun): AnyRun["continuation"] {
  return {
    ...run.continuation,
    noProgressAttempts: 0,
    progressRevisionSeen: run.progressRevision,
    stuck: false,
  }
}

function reduceStart(run: StartWorkRun, command: ControlCommand): ControlResult<StartWorkRun> {
  const terminal =
    run.payload.status === "completed" ||
    run.payload.status === "cancelled" ||
    run.payload.status === "failed" ||
    run.payload.status === "abandoned"
  switch (command.kind) {
    case "pause":
      return run.payload.status === "active"
        ? {
            ok: true,
            run: {
              ...run,
              revision: run.revision + 1,
              payload: { ...run.payload, status: "paused" },
            },
          }
        : { ok: false, code: "invalid_transition" }
    case "cancel":
      return terminal
        ? { ok: false, code: "terminal" }
        : {
            ok: true,
            run: {
              ...run,
              revision: run.revision + 1,
              payload: { ...run.payload, status: "cancelled" },
            },
          }
    case "resume":
      if (terminal) return { ok: false, code: "terminal" }
      if (run.payload.status !== "paused" && run.payload.status !== "stuck") {
        return { ok: false, code: "invalid_transition" }
      }
      return {
        ok: true,
        run: {
          ...run,
          revision: run.revision + 1,
          continuation: resetContinuation(run),
          payload: { ...run.payload, status: "active" },
        },
      }
    case "adopt":
      if (terminal) return { ok: false, code: "terminal" }
      if (run.payload.status !== "paused" && run.payload.status !== "stuck") {
        return { ok: false, code: "invalid_transition" }
      }
      return {
        ok: true,
        run: {
          ...run,
          revision: run.revision + 1,
          owner: { sessionId: command.sessionId, epoch: run.owner.epoch + 1 },
          continuation: resetContinuation(run),
          payload: { ...run.payload, status: "active" },
        },
      }
    case "reconcile_plan":
      if (terminal) return { ok: false, code: "terminal" }
      return {
        ok: true,
        run: {
          ...run,
          revision: run.revision + 1,
          progressRevision: run.progressRevision + 1,
          payload: {
            ...run.payload,
            plan: {
              ...run.payload.plan,
              taskIds: command.plan.taskIds,
              taskFingerprint: command.plan.fingerprint,
            },
          },
        },
      }
    default:
      return command satisfies never
  }
}

function reduceUlw(run: UlwLoopRun, command: ControlCommand): ControlResult<UlwLoopRun> {
  const terminal =
    run.payload.status === "completed" ||
    run.payload.status === "cancelled" ||
    run.payload.status === "failed"
  switch (command.kind) {
    case "pause":
      return run.payload.status === "active"
        ? {
            ok: true,
            run: {
              ...run,
              revision: run.revision + 1,
              payload: { ...run.payload, status: "paused" },
            },
          }
        : { ok: false, code: "invalid_transition" }
    case "cancel":
      return terminal
        ? { ok: false, code: "terminal" }
        : {
            ok: true,
            run: {
              ...run,
              revision: run.revision + 1,
              payload: { ...run.payload, status: "cancelled" },
            },
          }
    case "resume":
      if (terminal) return { ok: false, code: "terminal" }
      if (run.payload.status !== "paused" && run.payload.status !== "stuck") {
        return { ok: false, code: "invalid_transition" }
      }
      return {
        ok: true,
        run: {
          ...run,
          revision: run.revision + 1,
          continuation: resetContinuation(run),
          payload: { ...run.payload, status: "active" },
        },
      }
    case "adopt":
      if (terminal) return { ok: false, code: "terminal" }
      if (
        run.payload.status !== "paused" &&
        run.payload.status !== "stuck" &&
        run.payload.status !== "blocked" &&
        run.payload.status !== "needs_user_decision" &&
        run.payload.status !== "review_blocked"
      ) {
        return { ok: false, code: "invalid_transition" }
      }
      return {
        ok: true,
        run: {
          ...run,
          revision: run.revision + 1,
          owner: { sessionId: command.sessionId, epoch: run.owner.epoch + 1 },
          continuation: resetContinuation(run),
          payload: { ...run.payload, status: "active" },
        },
      }
    case "reconcile_plan":
      return { ok: false, code: "invalid_transition" }
    default:
      return command satisfies never
  }
}

export function reduceWorkflowControl(
  run: StartWorkRun,
  command: ControlCommand,
): ControlResult<StartWorkRun>
export function reduceWorkflowControl(
  run: UlwLoopRun,
  command: ControlCommand,
): ControlResult<UlwLoopRun>
export function reduceWorkflowControl(run: AnyRun, command: ControlCommand): ControlResult<AnyRun> {
  const conflict = precheck(run, command)
  if (conflict !== null) return conflict
  switch (run.workflow) {
    case "start_work":
      return reduceStart(run, command)
    case "ulw_loop":
      return reduceUlw(run, command)
    default:
      return run satisfies never
  }
}
