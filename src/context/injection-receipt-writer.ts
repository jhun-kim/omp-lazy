/**
 * Persists a per-session context-injection receipt as a v2 record at
 * `directive-activations/<sessionId>.json` under the state root.
 *
 * Guarantees:
 * - Written atomically under the repository lock.
 * - Never logs rule content.
 * - Never writes outside the state root.
 * - Never blocks or fails the context injection on a write error.
 *   A write failure is recorded as a degradation and the handler continues.
 */
import { z } from "zod"
import { atomicReplace } from "../state/atomic-file"
import type { CanonicalRoot } from "../state/domain"
import { directiveActivationPath, ensureStatePathContained, statePaths } from "../state/paths"
import { deadlineAfter, RepoLock } from "../state/repo-lock"

/**
 * Schema for the injection receipt record (schemaVersion 2).
 * Never includes rule content - only metadata.
 */
export const InjectionReceiptSchema = z.strictObject({
  schemaVersion: z.literal(2),
  sessionId: z.string().min(1),
  timestamp: z.string(),
  budget: z.strictObject({
    injectionBudgetBytes: z.number().int().nonnegative(),
    rulesBudgetBytes: z.number().int().nonnegative(),
    catalogBudgetBytes: z.number().int().nonnegative(),
  }),
  matched: z.array(
    z.strictObject({
      fileName: z.string().min(1),
      bytes: z.number().int().nonnegative(),
    }),
  ),
  dropped: z.array(
    z.strictObject({
      id: z.string().min(1),
      section: z.enum(["rules", "directive", "catalog"]),
      reason: z.string().min(1),
    }),
  ),
  totals: z.strictObject({
    rulesBytes: z.number().int().nonnegative(),
    catalogBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
  }),
})

export type InjectionReceipt = z.infer<typeof InjectionReceiptSchema>

export type InjectionReceiptInput = {
  readonly sessionId: string
  readonly matched: readonly { readonly fileName: string; readonly bytes: number }[]
  readonly dropped: readonly {
    readonly id: string
    readonly section: "rules" | "directive" | "catalog"
    readonly reason: string
  }[]
  readonly totals: {
    readonly rulesBytes: number
    readonly catalogBytes: number
    readonly totalBytes: number
  }
  readonly budget: {
    readonly injectionBudgetBytes: number
    readonly rulesBudgetBytes: number
    readonly catalogBudgetBytes: number
  }
}

export type ReceiptWriteResult =
  | { readonly ok: true; readonly status: "written" }
  | { readonly ok: false; readonly code: "degraded"; readonly reason: string }

/**
 * Writes a context-injection receipt atomically under the repository lock.
 * Returns a degradation record on any failure - never throws.
 */
export async function writeInjectionReceipt(
  root: CanonicalRoot,
  input: InjectionReceiptInput,
): Promise<ReceiptWriteResult> {
  try {
    const receipt: InjectionReceipt = {
      schemaVersion: 2,
      sessionId: input.sessionId,
      timestamp: new Date().toISOString(),
      budget: input.budget,
      matched: [...input.matched],
      dropped: [...input.dropped],
      totals: input.totals,
    }

    // Validate the receipt before writing
    const parsed = InjectionReceiptSchema.safeParse(receipt)
    if (!parsed.success) {
      return { ok: false, code: "degraded", reason: "receipt_schema_invalid" }
    }

    const path = directiveActivationPath(root, input.sessionId)
    const state = statePaths(root)
    const deadline = deadlineAfter(2_000)

    // Acquire the repo lock
    const lock = new RepoLock(state.lock, (p) => ensureStatePathContained(root, p))
    const handle = await lock.tryAcquire({
      deadline,
      purpose: "command",
      sessionId: input.sessionId,
      maxWaitMs: Math.min(1_000, deadline.remainingMs()),
    })

    if (handle === null) {
      return { ok: false, code: "degraded", reason: "lock_timeout" }
    }

    try {
      await ensureStatePathContained(root, path)
      await atomicReplace(path, JSON.stringify(receipt), {
        deadline,
        guard: (p) => ensureStatePathContained(root, p),
      })
      return { ok: true, status: "written" }
    } finally {
      await handle.release()
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message || error.name : "unknown_write_failure"
    return { ok: false, code: "degraded", reason }
  }
}
