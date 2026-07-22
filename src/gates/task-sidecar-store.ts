import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { atomicReplace } from "../state/atomic-file"
import type { AnyRun } from "../state/domain"
import { deadlineAfter } from "../state/repo-lock"
import type { TransactionStore } from "../state/transaction-store"
import {
  type PersistedTaskLedger,
  type TaskFact,
  taskFactKey,
  taskLedgerSchema,
  taskLedgerV2Schema,
} from "./task-ledger-codec"

export type TaskRunScope = {
  readonly indexRevision: number
  readonly run: AnyRun
  readonly ledger: PersistedTaskLedger
}

export type TaskScopeResult =
  | { readonly kind: "scope"; readonly value: TaskRunScope }
  | { readonly kind: "none" }
  | { readonly kind: "conflict" }

export type TaskLedgerDecision<T> =
  | { readonly kind: "return"; readonly value: T }
  | { readonly kind: "append"; readonly facts: readonly TaskFact[]; readonly value: T }

export type TaskLedgerTransaction<T> =
  | { readonly kind: "scope"; readonly value: T; readonly changed: boolean }
  | { readonly kind: "none" }
  | { readonly kind: "conflict" }

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function sameFact(left: TaskFact, right: TaskFact): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export class TaskSidecarStore {
  constructor(readonly store: TransactionStore) {}

  async resolve(sessionId: string): Promise<TaskScopeResult> {
    return this.#resolveUnlocked(sessionId)
  }

  async scopeForRun(run: AnyRun): Promise<TaskRunScope> {
    const index = await this.store.readIndex(false)
    return { indexRevision: index.revision, run, ledger: await this.#readLedger(run) }
  }

  async transact<T>(
    sessionId: string,
    decide: (scope: TaskRunScope) => TaskLedgerDecision<T>,
  ): Promise<TaskLedgerTransaction<T>> {
    const deadline = deadlineAfter(2_000)
    const handle = await this.store.lock.tryAcquire({
      deadline,
      purpose: "command",
      sessionId,
      maxWaitMs: Math.min(2_000, deadline.remainingMs()),
    })
    if (handle === null) return { kind: "conflict" }
    try {
      const resolved = await this.#resolveUnlocked(sessionId)
      if (resolved.kind !== "scope") return resolved
      const decision = decide(resolved.value)
      if (decision.kind === "return") {
        return { kind: "scope", value: decision.value, changed: false }
      }
      const merged = this.#merge(
        resolved.value.ledger,
        decision.facts,
        resolved.value.run.owner.sessionId,
        resolved.value.run.owner.epoch,
      )
      if (merged.kind === "conflict") return merged
      if (!merged.changed) {
        return { kind: "scope", value: decision.value, changed: false }
      }
      await atomicReplace(
        this.#ledgerPath(resolved.value.run.runId),
        JSON.stringify(merged.ledger),
        { deadline, guard: this.store.guard },
      )
      return { kind: "scope", value: decision.value, changed: true }
    } finally {
      await handle.release()
    }
  }

  #merge(
    ledger: PersistedTaskLedger,
    facts: readonly TaskFact[],
    ownerSessionId: string,
    ownerEpoch: number,
  ):
    | { readonly kind: "merged"; readonly ledger: PersistedTaskLedger; readonly changed: boolean }
    | { readonly kind: "conflict" } {
    const byKey = new Map(
      ledger.entries
        .filter(
          (entry) => entry.ownerSessionId === ownerSessionId && entry.ownerEpoch === ownerEpoch,
        )
        .map((entry) => [taskFactKey(entry.fact), entry.fact]),
    )
    const novel: TaskFact[] = []
    for (const fact of facts) {
      const key = taskFactKey(fact)
      const existing = byKey.get(key)
      if (existing !== undefined) {
        if (!sameFact(existing, fact)) return { kind: "conflict" }
        continue
      }
      if (novel.some((candidate) => taskFactKey(candidate) === key)) return { kind: "conflict" }
      novel.push(fact)
    }
    if (novel.length === 0) return { kind: "merged", ledger, changed: false }
    const entries = [
      ...ledger.entries,
      ...novel.map((fact, index) => ({
        sequence: ledger.ledgerRevision + index + 1,
        ownerSessionId,
        ownerEpoch,
        fact,
      })),
    ]
    return {
      kind: "merged",
      ledger:
        ledger.schemaVersion === 2
          ? taskLedgerV2Schema.parse({ ...ledger, ledgerRevision: entries.length, entries })
          : taskLedgerSchema.parse({ ...ledger, ledgerRevision: entries.length, entries }),
      changed: true,
    }
  }

  async #resolveUnlocked(sessionId: string): Promise<TaskScopeResult> {
    const index = await this.store.readIndex(false)
    const entries = index.entries.filter((entry) => entry.sessionId === sessionId)
    if (entries.length === 0) return { kind: "none" }
    if (entries.length !== 1) return { kind: "conflict" }
    const entry = entries[0]
    if (entry === undefined) return { kind: "conflict" }
    const run = await this.store.readRun(entry.runId, false)
    if (
      run === null ||
      run.revision !== entry.runRevision ||
      run.transactionRevision !== entry.transactionRevision ||
      run.workflow !== entry.workflow ||
      run.owner.sessionId !== entry.sessionId ||
      run.owner.epoch !== entry.ownerEpoch
    ) {
      return { kind: "conflict" }
    }
    const ledger = await this.#readLedger(run)
    return { kind: "scope", value: { indexRevision: index.revision, run, ledger } }
  }

  async #readLedger(run: AnyRun): Promise<PersistedTaskLedger> {
    let bytes: string
    const path = this.#ledgerPath(run.runId)
    await this.store.guard(path)
    try {
      bytes = await readFile(path, "utf8")
    } catch (error) {
      if (isMissing(error)) {
        return run.schemaVersion === 2
          ? taskLedgerV2Schema.parse({
              schemaVersion: 2,
              runId: run.runId,
              ledgerRevision: 0,
              entries: [],
              packetHash: null,
              tier: null,
              reservationId: null,
            })
          : taskLedgerSchema.parse({
              schemaVersion: 1,
              runId: run.runId,
              ledgerRevision: 0,
              entries: [],
            })
      }
      throw error
    }
    const raw: unknown = JSON.parse(bytes)
    const migrated = taskLedgerV2Schema.safeParse(raw)
    return migrated.success ? migrated.data : taskLedgerSchema.parse(raw)
  }

  #ledgerPath(runId: string): string {
    return join(this.store.paths.root, "task-facts", `${runId}.json`)
  }
}
