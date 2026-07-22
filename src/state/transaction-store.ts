import { readFile } from "node:fs/promises"
import { atomicReplace } from "./atomic-file"
import { decodeActiveIndex, decodeRun, StateDecodeError } from "./codec"
import type { ActiveIndex, AnyRun, CanonicalRoot, StateEvent } from "./domain"
import { UuidSchema } from "./domain"
import { EventStore } from "./event-store"
import { migrateLifecycleState, recoverLifecycleMigration } from "./migration"
import {
  ensureStatePathContained,
  runSnapshotPath,
  type StatePathGuard,
  StateRootContainmentError,
  statePaths,
} from "./paths"
import { type Deadline, RepoLock } from "./repo-lock"
import { prepareTransition, type TransitionErrorCode } from "./state-transition"

export type CrashPoint = "before_event" | "after_event" | "after_run" | "after_index"
export type TransactionErrorCode =
  | TransitionErrorCode
  | "lock_timeout"
  | "deadline_expired"
  | "state_diverged"
  | "state_root_escaped"
  | "state_root_unreadable"

export type TransactionResult =
  | { readonly ok: true; readonly run: AnyRun; readonly index: ActiveIndex }
  | { readonly ok: false; readonly code: TransactionErrorCode }

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

export class TransactionStore {
  readonly paths
  readonly events
  readonly lock
  readonly guard: StatePathGuard

  constructor(readonly root: CanonicalRoot) {
    this.paths = statePaths(root)
    this.guard = (path) => ensureStatePathContained(root, path)
    this.events = new EventStore(this.paths.root, this.guard)
    this.lock = new RepoLock(this.paths.lock, this.guard)
  }

  async commit(
    event: StateEvent,
    options: { readonly deadline: Deadline; readonly crash?: (point: CrashPoint) => void },
  ): Promise<TransactionResult> {
    if (!options.deadline.isValid()) return { ok: false, code: "deadline_expired" }
    try {
      await Promise.all([
        ensureStatePathContained(this.root, this.paths.lock),
        ensureStatePathContained(this.root, this.events.eventPath(event)),
        ensureStatePathContained(this.root, runSnapshotPath(this.root, event.runId)),
        ensureStatePathContained(this.root, this.paths.activeIndex),
      ])
    } catch (error) {
      if (error instanceof StateRootContainmentError) return { ok: false, code: error.code }
      throw error
    }
    const handle = await this.lock.tryAcquire({
      deadline: options.deadline,
      purpose: "command",
      sessionId: event.expected.ownerSessionId ?? "create",
      maxWaitMs: Math.min(2_000, options.deadline.remainingMs()),
    })
    if (handle === null) {
      return options.deadline.isValid()
        ? { ok: false, code: "lock_timeout" }
        : { ok: false, code: "deadline_expired" }
    }
    try {
      const index = await this.readIndex(false)
      const events = await this.events.readAll()
      const highest = events.at(-1)?.sequence ?? 0
      if (highest !== index.revision) return { ok: false, code: "state_diverged" }
      const current = await this.readRun(event.runId, false)
      const prepared = prepareTransition(index, current, event)
      if ("code" in prepared) return { ok: false, code: prepared.code }
      options.crash?.("before_event")
      if (!options.deadline.isValid()) return { ok: false, code: "deadline_expired" }
      await this.events.append(event, options.deadline)
      options.crash?.("after_event")
      if (!options.deadline.isValid()) return { ok: false, code: "deadline_expired" }
      await atomicReplace(
        runSnapshotPath(this.root, prepared.run.runId),
        JSON.stringify(prepared.run),
        {
          deadline: options.deadline,
          guard: this.guard,
        },
      )
      options.crash?.("after_run")
      if (!options.deadline.isValid()) return { ok: false, code: "deadline_expired" }
      await atomicReplace(this.paths.activeIndex, JSON.stringify(prepared.index), {
        deadline: options.deadline,
        guard: this.guard,
      })
      options.crash?.("after_index")
      return { ok: true, ...prepared }
    } finally {
      await handle.release()
    }
  }

  async preflightLifecycle(): Promise<void> {
    let bytes: string
    try {
      bytes = await readFile(this.paths.activeIndex, "utf8")
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(bytes)
    } catch (error) {
      if (error instanceof SyntaxError) throw new StateDecodeError("malformed_index")
      throw error
    }
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      "schemaVersion" in value &&
      value.schemaVersion === 2
    ) {
      return
    }
    const migrated = await migrateLifecycleState({ root: this.root })
    if (migrated.ok) return
    const recovered = await recoverLifecycleMigration(this.root)
    if (!recovered.ok) throw new StateDecodeError(recovered.code)
    const retried = await migrateLifecycleState({ root: this.root })
    if (!retried.ok) throw new StateDecodeError(retried.code)
  }

  async readIndex(preflight = true): Promise<ActiveIndex> {
    if (preflight) await this.preflightLifecycle()
    await ensureStatePathContained(this.root, this.paths.activeIndex)
    let bytes: string
    try {
      bytes = await readFile(this.paths.activeIndex, "utf8")
    } catch (error) {
      if (isMissing(error)) return { schemaVersion: 1, revision: 0, entries: [] }
      throw error
    }
    const decoded = decodeActiveIndex(bytes)
    if (!decoded.ok) throw decoded.error
    return decoded.value
  }

  async readRun(runId: string, preflight = true): Promise<AnyRun | null> {
    if (preflight) await this.preflightLifecycle()
    const parsedId = UuidSchema.safeParse(runId)
    if (!parsedId.success) return null
    await ensureStatePathContained(this.root, runSnapshotPath(this.root, parsedId.data))
    let bytes: string
    try {
      bytes = await readFile(runSnapshotPath(this.root, parsedId.data), "utf8")
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
    const decoded = decodeRun(bytes, this.root)
    if (!decoded.ok) throw decoded.error
    return decoded.value
  }
}
