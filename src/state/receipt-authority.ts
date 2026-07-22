import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { z } from "zod"
import {
  rejectionLedgerSchema,
  rejectionLedgerV2Schema,
  type ScopedWorkerAcceptanceEvent,
  WorkerAcceptanceLedger,
} from "../contracts/worker-acceptance-ledger"
import { taskGeneration } from "../gates/task-ledger-view"
import { TaskSidecarStore } from "../gates/task-sidecar-store"
import type { AnyRun, StartWorkRun } from "./domain"
import type { TransactionStore } from "./transaction-store"

export type ReceiptAuthority = {
  readonly taskGeneration: number
  readonly accepted: readonly ScopedWorkerAcceptanceEvent[]
  readonly rejected: z.infer<typeof rejectionLedgerV2Schema>["entries"]
}

export const EMPTY_RECEIPT_AUTHORITY: ReceiptAuthority = {
  taskGeneration: 0,
  accepted: [],
  rejected: [],
}

export async function readReceiptAuthority(
  store: TransactionStore,
  run: AnyRun,
): Promise<ReceiptAuthority> {
  const ledger = new WorkerAcceptanceLedger(store)
  const rejectionPath = join(store.paths.root, "worker-rejections", `${run.runId}.json`)
  const [scope, accepted, rejected] = await Promise.all([
    new TaskSidecarStore(store).scopeForRun(run),
    ledger.scopedEntries(run.runId),
    (async () => {
      await store.guard(rejectionPath)
      try {
        const raw: unknown = JSON.parse(await readFile(rejectionPath, "utf8"))
        const v2 = rejectionLedgerV2Schema.safeParse(raw)
        if (v2.success) return v2.data.entries
        rejectionLedgerSchema.parse(raw)
        return []
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
        throw error
      }
    })(),
  ])
  return { taskGeneration: taskGeneration(scope), accepted, rejected }
}

function matchesRun(run: AnyRun, entry: ScopedWorkerAcceptanceEvent): boolean {
  return (
    run.schemaVersion === 2 &&
    run.expectedHead !== null &&
    entry.taskId !== null &&
    entry.ownerSessionId === run.owner.sessionId &&
    entry.ownerEpoch === run.owner.epoch &&
    entry.captureCommit === run.expectedHead
  )
}

export function currentAcceptance(
  run: AnyRun,
  authority: ReceiptAuthority,
  taskId: string,
): ScopedWorkerAcceptanceEvent | null {
  if (authority.taskGeneration === 0) return null
  return (
    authority.accepted.findLast(
      (entry) =>
        matchesRun(run, entry) &&
        entry.taskId === taskId &&
        entry.taskGeneration === authority.taskGeneration &&
        entry.attempt === run.progressRevision,
    ) ?? null
  )
}

export function startCompletionAcceptanceIds(
  run: StartWorkRun,
  authority: ReceiptAuthority,
): readonly string[] | null {
  const finalTaskId = run.payload.plan.taskIds.at(-1)
  if (finalTaskId === undefined || currentAcceptance(run, authority, finalTaskId) === null) {
    return null
  }
  const selected = run.payload.plan.taskIds.map((taskId) =>
    authority.accepted.findLast((entry) => matchesRun(run, entry) && entry.taskId === taskId),
  )
  return selected.some((entry) => entry === undefined)
    ? null
    : selected.flatMap((entry) => (entry === undefined ? [] : [entry.idempotencyKey]))
}

export function exhaustedTaskId(run: AnyRun, authority: ReceiptAuthority): string | null {
  if (authority.taskGeneration === 0) return null
  return (
    authority.rejected.findLast(
      (entry) =>
        entry.ownerEpoch === run.owner.epoch &&
        entry.taskGeneration === authority.taskGeneration &&
        entry.count === 3 &&
        entry.status === "needs_parent_decision" &&
        currentAcceptance(run, authority, entry.taskId) === null,
    )?.taskId ?? null
  )
}
