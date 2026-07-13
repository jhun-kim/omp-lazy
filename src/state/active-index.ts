import type { ActiveIndex, AnyRun, WorkflowKind } from "./domain"

export type IndexResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "duplicate_active_key" | "duplicate_run" }

export type ActiveRunQuery = {
  readonly runs: readonly AnyRun[]
  readonly workflow: WorkflowKind
  readonly sessionId: string
}

export function validateActiveIndex(_index: ActiveIndex): IndexResult {
  const keys = new Set<string>()
  const runIds = new Set<string>()
  for (const entry of _index.entries) {
    const key = `${entry.workflow}\u0000${entry.sessionId}`
    if (keys.has(key)) return { ok: false, code: "duplicate_active_key" }
    if (runIds.has(entry.runId)) return { ok: false, code: "duplicate_run" }
    keys.add(key)
    runIds.add(entry.runId)
  }
  return { ok: true }
}

export function resolveActiveRun(
  _index: ActiveIndex,
  query: ActiveRunQuery,
):
  | { readonly ok: true; readonly run: AnyRun }
  | {
      readonly ok: false
      readonly code: "foreign_owner" | "missing_target" | "revision_mismatch" | "state_conflict"
    } {
  if (!validateActiveIndex(_index).ok) return { ok: false, code: "state_conflict" }
  const entry = _index.entries.find(
    (candidate) => candidate.workflow === query.workflow && candidate.sessionId === query.sessionId,
  )
  if (entry === undefined) return { ok: false, code: "foreign_owner" }
  const run = query.runs.find((candidate) => candidate.runId === entry.runId)
  if (run === undefined) return { ok: false, code: "missing_target" }
  if (
    run.revision !== entry.runRevision ||
    run.transactionRevision !== entry.transactionRevision ||
    entry.transactionRevision !== _index.revision
  ) {
    return { ok: false, code: "revision_mismatch" }
  }
  if (
    run.workflow !== entry.workflow ||
    run.owner.sessionId !== entry.sessionId ||
    run.owner.epoch !== entry.ownerEpoch
  ) {
    return { ok: false, code: "state_conflict" }
  }
  let statusHintMatches: boolean
  const status = run.payload.status
  switch (status) {
    case "active":
      statusHintMatches = entry.statusHint === "active"
      break
    case "paused":
      statusHintMatches = entry.statusHint === "paused"
      break
    case "stuck":
      statusHintMatches = entry.statusHint === "stuck"
      break
    case "blocked":
    case "needs_user_decision":
    case "review_blocked":
      statusHintMatches = entry.statusHint === "blocked"
      break
    case "completed":
    case "cancelled":
    case "failed":
    case "abandoned":
      statusHintMatches = false
      break
    default:
      return status satisfies never
  }
  if (!statusHintMatches) return { ok: false, code: "state_conflict" }
  return { ok: true, run }
}
