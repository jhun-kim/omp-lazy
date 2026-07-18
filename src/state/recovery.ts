import { atomicReplace } from "./atomic-file"
import { StateDecodeError } from "./codec"
import type { ActiveIndex, AnyRun, CanonicalRoot } from "./domain"
import { EventStoreError } from "./event-store"
import {
  ensureStatePathContained,
  runSnapshotPath,
  StateRootContainmentError,
  statePaths,
} from "./paths"
import { type Deadline, LockHandle, RepoLock } from "./repo-lock"
import { deriveIndex, prepareTransition } from "./state-transition"
import { TransactionStore } from "./transaction-store"

export type RecoveryInspection =
  | { readonly kind: "healthy"; readonly revision: number }
  | { readonly kind: "repairable"; readonly eventSequence: number }
  | {
      readonly kind: "conflict"
      readonly code: "multiple_events_ahead" | "index_ahead" | "corrupt"
    }

export async function inspectRecovery(root: CanonicalRoot): Promise<RecoveryInspection> {
  try {
    const store = new TransactionStore(root)
    const index = await store.readIndex()
    const events = await store.events.readAll()
    const highest = events.at(-1)?.sequence ?? 0
    if (highest === index.revision) return { kind: "healthy", revision: index.revision }
    if (highest === index.revision + 1) return { kind: "repairable", eventSequence: highest }
    return highest > index.revision
      ? { kind: "conflict", code: "multiple_events_ahead" }
      : { kind: "conflict", code: "index_ahead" }
  } catch (error) {
    if (error instanceof EventStoreError || error instanceof StateDecodeError) {
      return { kind: "conflict", code: "corrupt" }
    }
    throw error
  }
}

export async function repairState(
  root: CanonicalRoot,
  deadline: Deadline,
): Promise<
  | { readonly ok: true; readonly run: AnyRun; readonly index: ActiveIndex }
  | { readonly ok: false; readonly code: string }
> {
  if (!deadline.isValid()) return { ok: false, code: "deadline_expired" }
  const paths = statePaths(root)
  const guard = (path: string): Promise<void> => ensureStatePathContained(root, path)
  try {
    await guard(paths.lock)
  } catch (error) {
    if (error instanceof StateRootContainmentError) return { ok: false, code: error.code }
    throw error
  }
  const lock = new RepoLock(paths.lock, guard)
  const handle = await lock.tryAcquire({
    deadline,
    purpose: "command",
    sessionId: "repair",
    maxWaitMs: Math.min(2_000, deadline.remainingMs()),
  })
  if (handle === null) return { ok: false, code: "lock_timeout" }
  try {
    const store = new TransactionStore(root)
    const index = await store.readIndex()
    const events = await store.events.readAll()
    const event = events.at(-1)
    if (event === undefined || event.sequence !== index.revision + 1) {
      return { ok: false, code: "not_repairable" }
    }
    if (event.expected.indexRevision !== index.revision) {
      return { ok: false, code: "index_revision_conflict" }
    }
    const current = await store.readRun(event.runId)
    let run: AnyRun
    let runPublished = false
    if (current?.transactionRevision === event.sequence) {
      if (current.runId !== event.runId || current.workflow !== event.workflow) {
        return { ok: false, code: "run_conflict" }
      }
      run = current
      runPublished = true
    } else {
      const prepared = prepareTransition(index, current, event)
      if ("code" in prepared) return { ok: false, code: prepared.code }
      run = prepared.run
    }
    const nextIndex = deriveIndex(index, run, event.sequence)
    if (!deadline.isValid()) return { ok: false, code: "deadline_expired" }
    if (!runPublished) {
      await atomicReplace(runSnapshotPath(root, run.runId), JSON.stringify(run), {
        deadline,
        guard,
      })
    }
    if (!deadline.isValid()) return { ok: false, code: "deadline_expired" }
    await atomicReplace(paths.activeIndex, JSON.stringify(nextIndex), { deadline, guard })
    return { ok: true, run, index: nextIndex }
  } finally {
    await handle.release()
  }
}

export async function clearConfirmedStaleLock(request: {
  readonly root: CanonicalRoot
  readonly lockPath: string
  readonly expectedNonce: string
  readonly ownerAlive: boolean
  readonly confirmed: boolean
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }> {
  if (!request.confirmed) return { ok: false, code: "confirmation_required" }
  if (request.ownerAlive) return { ok: false, code: "owner_alive" }
  const guard = (path: string): Promise<void> => ensureStatePathContained(request.root, path)
  const lock = new RepoLock(request.lockPath, guard)
  const metadata = await lock.readMetadata()
  if (metadata === null) return { ok: false, code: "lock_missing" }
  if (metadata.nonce !== request.expectedNonce) return { ok: false, code: "nonce_mismatch" }
  return (await new LockHandle(request.lockPath, metadata, guard).release())
    ? { ok: true }
    : { ok: false, code: "nonce_mismatch" }
}
