import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { atomicReplace } from "../state/atomic-file"
import { UuidSchema } from "../state/domain"
import type { Deadline } from "../state/repo-lock"
import type { TransactionStore } from "../state/transaction-store"
import { AgentIdSchema, JobIdSchema } from "./agent-ids"
import type { EvidenceBundle } from "./artifact-containment"
import { WorkerRoleSchema } from "./evidence-receipt"
import { appendAcceptanceWal, readAcceptanceWal } from "./worker-acceptance-wal"

const counter = z.number().int().nonnegative()
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const commit = z.string().regex(/^[0-9a-f]{40}$/)
const nonempty = z.string().trim().min(1)

export const acceptanceEventSchema = z
  .object({
    sequence: counter.positive(),
    idempotencyKey: nonempty,
    runId: UuidSchema,
    attempt: counter,
    runRevision: counter,
    ownerSessionId: nonempty,
    ownerEpoch: counter,
    taskGeneration: counter.positive(),
    workerRole: WorkerRoleSchema,
    actualAgentId: AgentIdSchema,
    actualJobId: JobIdSchema.nullable(),
    captureCommit: commit,
    receiptPath: nonempty,
    receiptHash: hash,
    artifactHash: hash,
    artifactPaths: z.array(nonempty).min(1).readonly(),
    cleanupReceiptPaths: z.array(nonempty).min(1).readonly(),
    parentDecision: z.literal("accept_after_review").optional(),
  })
  .strict()

export type WorkerAcceptanceEvent = z.infer<typeof acceptanceEventSchema>

const acceptanceLedgerEntryV2Schema = acceptanceEventSchema
  .extend({
    taskId: nonempty,
    role: WorkerRoleSchema,
    semanticAttempt: counter,
  })
  .strict()
export const acceptanceEventV2Schema = acceptanceLedgerEntryV2Schema
  .extend({ schemaVersion: z.literal(2) })
  .strict()

export const acceptanceLedgerSchema = z.object({
  schemaVersion: z.literal(1),
  runId: UuidSchema,
  ledgerRevision: counter,
  entries: z.array(acceptanceEventSchema).readonly(),
})

export const acceptanceLedgerV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    runId: UuidSchema,
    ledgerRevision: counter,
    entries: z.array(acceptanceLedgerEntryV2Schema).readonly(),
  })
  .strict()
  .superRefine((ledger, context) => {
    if (
      ledger.ledgerRevision !== ledger.entries.length ||
      ledger.entries.some(
        (entry, index) => entry.sequence !== index + 1 || entry.runId !== ledger.runId,
      ) ||
      new Set(ledger.entries.map((entry) => entry.idempotencyKey)).size !== ledger.entries.length
    ) {
      context.addIssue({ code: "custom", message: "acceptance ledger sequence mismatch" })
    }
  })
  .strict()
  .superRefine((ledger, context) => {
    if (
      ledger.ledgerRevision !== ledger.entries.length ||
      ledger.entries.some((entry, index) => entry.sequence !== index + 1) ||
      new Set(ledger.entries.map((entry) => entry.idempotencyKey)).size !== ledger.entries.length
    ) {
      context.addIssue({ code: "custom", message: "acceptance ledger sequence mismatch" })
    }
  })

export const rejectionEntrySchema = z
  .object({
    runId: UuidSchema,
    attempt: counter,
    runRevision: counter,
    ownerEpoch: counter,
    taskGeneration: counter.positive(),
    actualAgentId: AgentIdSchema,
    count: z.number().int().min(1).max(3),
    status: z.enum(["retry_allowed", "needs_parent_decision"]),
  })
  .strict()

export const rejectionLedgerSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: UuidSchema,
    entries: z.array(rejectionEntrySchema).readonly(),
  })
  .strict()

export const rejectionEntryV2Schema = rejectionEntrySchema
  .extend({
    taskId: nonempty,
    role: WorkerRoleSchema,
    semanticAttempt: counter,
  })
  .strict()
export const rejectionLedgerV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    runId: UuidSchema,
    entries: z.array(rejectionEntryV2Schema).readonly(),
  })
  .strict()
  .superRefine((ledger, context) => {
    if (ledger.entries.some((entry) => entry.runId !== ledger.runId)) {
      context.addIssue({ code: "custom", message: "rejection ledger run mismatch" })
    }
  })

type AcceptanceLedger = z.infer<typeof acceptanceLedgerSchema>
type RejectionScope = Omit<z.infer<typeof rejectionEntrySchema>, "count" | "status">
type V2RejectionEntry = z.infer<typeof rejectionEntryV2Schema>
type V2RejectionScope = Omit<V2RejectionEntry, "count" | "status">
type RuntimeRejectionEntry = z.infer<typeof rejectionEntrySchema> &
  Partial<Pick<V2RejectionEntry, "taskId" | "role" | "semanticAttempt">>
type RuntimeRejectionLedger = {
  readonly schemaVersion: 1 | 2
  readonly runId: z.infer<typeof UuidSchema>
  readonly entries: readonly RuntimeRejectionEntry[]
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export class WorkerAcceptanceLedgerError extends Error {
  readonly name = "WorkerAcceptanceLedgerError"

  constructor(readonly code: "wal_diverged") {
    super(code)
  }
}

function rejectionKey(scope: RejectionScope | V2RejectionScope | RuntimeRejectionEntry): string {
  return "taskId" in scope && "role" in scope && "semanticAttempt" in scope
    ? [scope.runId, scope.taskId, scope.taskGeneration, scope.role, scope.semanticAttempt].join(
        "\u0000",
      )
    : [scope.runId, scope.attempt].join("\u0000")
}

export class WorkerAcceptanceLedger {
  constructor(readonly store: TransactionStore) {}

  acceptancePath(runId: string): string {
    return join(this.store.paths.root, "worker-acceptance", `${runId}.json`)
  }

  rejectionPath(runId: string): string {
    return join(this.store.paths.root, "worker-rejections", `${runId}.json`)
  }

  acceptanceWalPath(runId: string): string {
    return join(this.store.paths.root, "worker-acceptance", `${runId}.wal.jsonl`)
  }

  async rejectionCount(scope: RejectionScope): Promise<number> {
    const ledger = await this.#readRejections(scope.runId)
    return ledger.entries.find((entry) => rejectionKey(entry) === rejectionKey(scope))?.count ?? 0
  }

  async reject(scope: RejectionScope, deadline: Deadline): Promise<number> {
    const ledger = await this.#readRejections(scope.runId)
    const existing = ledger.entries.find((entry) => rejectionKey(entry) === rejectionKey(scope))
    if (existing?.count === 3) return 3
    const count = (existing?.count ?? 0) + 1
    const replacement = {
      ...scope,
      count,
      status: count === 3 ? "needs_parent_decision" : "retry_allowed",
    } as const
    const entries =
      existing === undefined
        ? [...ledger.entries, replacement]
        : ledger.entries.map((entry) =>
            rejectionKey(entry) === rejectionKey(scope) ? replacement : entry,
          )
    await atomicReplace(
      this.rejectionPath(scope.runId),
      JSON.stringify(rejectionLedgerSchema.parse({ ...ledger, entries })),
      { deadline, guard: this.store.guard },
    )
    return count
  }

  async accept(
    event: Omit<WorkerAcceptanceEvent, "sequence" | "idempotencyKey" | "receiptHash">,
    evidence: EvidenceBundle,
    deadline: Deadline,
  ): Promise<"accepted" | "replayed" | "duplicate_receipt"> {
    const ledger = await this.#readAcceptance(event.runId)
    const idempotencyKey = [
      event.runId,
      event.attempt,
      event.actualAgentId,
      event.artifactHash,
    ].join("\u0000")
    const candidate = acceptanceEventSchema.parse({
      ...event,
      sequence: ledger.ledgerRevision + 1,
      idempotencyKey,
      receiptHash: evidence.receiptFile.sha256,
    })
    const existing = ledger.entries.find((entry) => entry.idempotencyKey === idempotencyKey)
    if (existing !== undefined) {
      return same(existing, { ...candidate, sequence: existing.sequence })
        ? "replayed"
        : "duplicate_receipt"
    }
    const updated = acceptanceLedgerSchema.parse({
      ...ledger,
      ledgerRevision: ledger.ledgerRevision + 1,
      entries: [...ledger.entries, candidate],
    })
    await appendAcceptanceWal(this.acceptanceWalPath(event.runId), candidate, {
      deadline,
      guard: this.store.guard,
    })
    await atomicReplace(this.acceptancePath(event.runId), JSON.stringify(updated), {
      deadline,
      guard: this.store.guard,
    })
    return "accepted"
  }

  async entries(runId: string): Promise<readonly WorkerAcceptanceEvent[]> {
    return (await this.#readAcceptance(runId)).entries
  }

  async #readAcceptance(runId: string): Promise<AcceptanceLedger> {
    let snapshot: AcceptanceLedger
    const path = this.acceptancePath(runId)
    await this.store.guard(path)
    try {
      const raw: unknown = JSON.parse(await readFile(path, "utf8"))
      const v2 = acceptanceLedgerV2Schema.safeParse(raw)
      snapshot = v2.success
        ? acceptanceLedgerSchema.parse({
            schemaVersion: 1,
            runId: v2.data.runId,
            ledgerRevision: v2.data.ledgerRevision,
            entries: v2.data.entries.map(
              ({ taskId: _taskId, role: _role, semanticAttempt: _semanticAttempt, ...entry }) =>
                entry,
            ),
          })
        : acceptanceLedgerSchema.parse(raw)
    } catch (error) {
      if (isMissing(error)) {
        snapshot = acceptanceLedgerSchema.parse({
          schemaVersion: 1,
          runId,
          ledgerRevision: 0,
          entries: [],
        })
      } else {
        throw error
      }
    }
    const entries = [...snapshot.entries]
    for (const raw of await readAcceptanceWal(this.acceptanceWalPath(runId), this.store.guard)) {
      const v2 = acceptanceEventV2Schema.safeParse(raw)
      const event = v2.success
        ? acceptanceEventSchema.parse(
            (({
              schemaVersion: _schemaVersion,
              taskId: _taskId,
              role: _role,
              semanticAttempt: _semanticAttempt,
              ...entry
            }) => entry)(v2.data),
          )
        : acceptanceEventSchema.parse(raw)
      const existing = entries[event.sequence - 1]
      if (existing !== undefined) {
        if (!same(existing, event)) throw new WorkerAcceptanceLedgerError("wal_diverged")
        continue
      }
      entries.push(event)
    }
    return acceptanceLedgerSchema.parse({
      ...snapshot,
      ledgerRevision: entries.length,
      entries,
    })
  }

  async #readRejections(runId: string): Promise<RuntimeRejectionLedger> {
    const path = this.rejectionPath(runId)
    await this.store.guard(path)
    try {
      const raw: unknown = JSON.parse(await readFile(path, "utf8"))
      const v2 = rejectionLedgerV2Schema.safeParse(raw)
      return v2.success ? v2.data : rejectionLedgerSchema.parse(raw)
    } catch (error) {
      if (isMissing(error)) {
        return rejectionLedgerSchema.parse({ schemaVersion: 1, runId, entries: [] })
      }
      throw error
    }
  }
}
