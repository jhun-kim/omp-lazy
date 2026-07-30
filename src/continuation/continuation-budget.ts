/**
 * Persisted per-session continuation counter.
 *
 * The host exposes no continuation cap (grep for maxContinuation|stopHookDepth|MAX_CONTINUATION
 * in the host source returns nothing), so omp-lazy owns the bound.
 *
 * The counter increments per emitted continuation, saturates at MAX_IDLE_CONTINUATIONS (the next
 * idle edge emits no continuation and records a `continuation_budget_exhausted` reason), and resets
 * on a new user turn (diagnosticTurnId change) or a new run id.
 */
import { readFile } from "node:fs/promises"
import { atomicReplace } from "../state/atomic-file"
import type { CanonicalRoot } from "../state/domain"
import { continuationCounterPath } from "../state/paths"
import type { DeadlineFence } from "./deadline-fence"

/**
 * Maximum idle continuations per session before saturation.
 * The 9th idle edge emits no continuation and records `continuation_budget_exhausted`.
 */
export const MAX_IDLE_CONTINUATIONS = 8

export type ContinuationCounter = {
  readonly schemaVersion: 2
  readonly sessionId: string
  readonly runId: string
  readonly turnId: number
  readonly count: number
  readonly reason?: "continuation_budget_exhausted"
}

export type BudgetCheckResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "continuation_budget_exhausted" }

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

/**
 * Read the persisted counter for the given session. Returns null if missing or malformed
 * (malformed is treated as reset - defensive repair).
 */
export async function readContinuationCounter(
  root: CanonicalRoot,
  sessionId: string,
): Promise<ContinuationCounter | null> {
  const path = continuationCounterPath(root, sessionId)
  try {
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw)
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.schemaVersion !== 2 ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.runId !== "string" ||
      typeof parsed.turnId !== "number" ||
      typeof parsed.count !== "number" ||
      !Number.isFinite(parsed.count) ||
      parsed.count < 0
    ) {
      // Malformed: treat as absent (will be overwritten on next write)
      return null
    }
    return parsed as ContinuationCounter
  } catch (error) {
    if (isMissing(error)) return null
    // Any other read error (permissions, etc.): treat as absent for safety
    return null
  }
}

/**
 * Check whether a continuation is allowed for the given session/run/turn combination.
 * Resets the counter if the runId or turnId has changed.
 */
export function checkBudget(
  existing: ContinuationCounter | null,
  currentRunId: string,
  currentTurnId: number,
): BudgetCheckResult {
  if (existing === null) {
    return { allowed: true }
  }
  // Reset conditions: new run or new user turn
  if (existing.runId !== currentRunId || existing.turnId !== currentTurnId) {
    return { allowed: true }
  }
  // Saturation check
  if (existing.count >= MAX_IDLE_CONTINUATIONS) {
    return { allowed: false, reason: "continuation_budget_exhausted" }
  }
  return { allowed: true }
}

/**
 * Write the updated counter atomically. On write failure, returns false (caller should
 * NOT block on write failure - degrade gracefully).
 */
export async function writeContinuationCounter(
  root: CanonicalRoot,
  counter: ContinuationCounter,
  fence: DeadlineFence,
): Promise<boolean> {
  const path = continuationCounterPath(root, counter.sessionId)
  try {
    await atomicReplace(path, JSON.stringify(counter), { deadline: fence })
    return true
  } catch {
    return false
  }
}

/**
 * Compute the next counter state after a continuation is emitted.
 */
export function incrementCounter(
  existing: ContinuationCounter | null,
  sessionId: string,
  runId: string,
  turnId: number,
): ContinuationCounter {
  if (existing === null || existing.runId !== runId || existing.turnId !== turnId) {
    // Fresh counter
    return { schemaVersion: 2, sessionId, runId, turnId, count: 1 }
  }
  return { ...existing, count: existing.count + 1 }
}

/**
 * Record that the budget was exhausted (for audit purposes).
 */
export function exhaustedCounter(
  existing: ContinuationCounter | null,
  sessionId: string,
  runId: string,
  turnId: number,
): ContinuationCounter {
  if (existing === null || existing.runId !== runId || existing.turnId !== turnId) {
    // Shouldn't happen (budget check should catch this), but be defensive
    return {
      schemaVersion: 2,
      sessionId,
      runId,
      turnId,
      count: MAX_IDLE_CONTINUATIONS,
      reason: "continuation_budget_exhausted",
    }
  }
  return { ...existing, reason: "continuation_budget_exhausted" }
}
