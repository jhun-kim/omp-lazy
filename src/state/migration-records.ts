import { z } from "zod"
import {
  acceptanceEventSchema,
  acceptanceEventV2Schema,
  acceptanceLedgerSchema,
  acceptanceLedgerV2Schema,
  rejectionLedgerSchema,
  rejectionLedgerV2Schema,
} from "../contracts/worker-acceptance-ledger"
import { taskLedgerSchema } from "../gates/task-ledger-codec"
import { TeamNameSchema, TeamStateSchema } from "../workflows/teammode-domain"
import { activeIndexSchema, runSchema, stateEventSchema, stateEventV2Schema } from "./codec-schemas"
import { type TaskIdentity, taskIdentities } from "./migration-identities"

const TombstoneSchema = z.strictObject({
  deleted: z.literal(true),
  schemaVersion: z.literal(1),
  teamName: TeamNameSchema,
})
const RecordSchema = z.record(z.string(), z.unknown())
type JsonRecord = Record<string, unknown> & {
  readonly schemaVersion?: unknown
  readonly entries?: unknown
  readonly expected?: unknown
  readonly status?: unknown
  readonly kind?: unknown
}

export type MigrationRecordResult =
  | { readonly kind: "current"; readonly bytes: string }
  | { readonly kind: "migrated"; readonly bytes: string }
  | { readonly kind: "invalid" }

function parseRecord(bytes: string): JsonRecord | null {
  try {
    const parsed = RecordSchema.safeParse(JSON.parse(bytes))
    return parsed.success ? parsed.data : null
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

function schemaVersion(value: JsonRecord): 1 | 2 | null {
  const version = value.schemaVersion
  return version === 1 || version === 2 ? version : null
}

function omit(value: JsonRecord, keys: readonly string[]): JsonRecord {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
}

function currentV2(value: JsonRecord, parser: z.ZodType): boolean {
  if (schemaVersion(value) !== 2) return false
  return parser.safeParse({ ...omit(value, ["schemaVersion"]), schemaVersion: 1 }).success
}

function identityFor(
  identities: readonly TaskIdentity[],
  runId: string,
  agentId: string,
  role?: string,
): TaskIdentity | null {
  const matches = identities.filter(
    (identity) =>
      identity.runId === runId &&
      identity.agentId === agentId &&
      (role === undefined || identity.role === role),
  )
  return matches.length === 1 ? (matches[0] ?? null) : null
}

function migrateAcceptance(
  value: JsonRecord,
  identities: readonly TaskIdentity[],
): MigrationRecordResult {
  if (acceptanceLedgerV2Schema.safeParse(value).success)
    return { kind: "current", bytes: JSON.stringify(value) }
  if (schemaVersion(value) !== 1) return { kind: "invalid" }
  const parsed = acceptanceLedgerSchema.safeParse(value)
  if (!parsed.success) return { kind: "invalid" }
  const entries = parsed.data.entries.map((entry) => {
    const identity = identityFor(identities, entry.runId, entry.actualAgentId, entry.workerRole)
    return identity === null
      ? null
      : { ...entry, taskId: identity.taskId, role: identity.role, semanticAttempt: 1 }
  })
  if (entries.some((entry) => entry === null)) return { kind: "invalid" }
  return { kind: "migrated", bytes: JSON.stringify({ ...value, schemaVersion: 2, entries }) }
}

function migrateRejections(
  value: JsonRecord,
  identities: readonly TaskIdentity[],
): MigrationRecordResult {
  if (rejectionLedgerV2Schema.safeParse(value).success)
    return { kind: "current", bytes: JSON.stringify(value) }
  if (schemaVersion(value) !== 1) return { kind: "invalid" }
  const parsed = rejectionLedgerSchema.safeParse(value)
  if (!parsed.success) return { kind: "invalid" }
  const converted = parsed.data.entries.map((entry) => {
    const identity = identityFor(identities, entry.runId, entry.actualAgentId)
    return identity === null
      ? null
      : { ...entry, taskId: identity.taskId, role: identity.role, semanticAttempt: 1 }
  })
  const entries = new Map<string, Exclude<(typeof converted)[number], null>>()
  for (const entry of converted) {
    if (entry === null) return { kind: "invalid" }
    const key = [entry.runId, entry.taskId, entry.taskGeneration, entry.role, 1].join("\u0000")
    const prior = entries.get(key)
    const count = Math.min(3, (prior?.count ?? 0) + entry.count)
    entries.set(key, {
      ...entry,
      count,
      status: count === 3 ? "needs_parent_decision" : "retry_allowed",
    })
  }
  return {
    kind: "migrated",
    bytes: JSON.stringify({ ...value, schemaVersion: 2, entries: [...entries.values()] }),
  }
}

function migrateWal(bytes: string, identities: readonly TaskIdentity[]): MigrationRecordResult {
  const lines = bytes.split("\n").filter((line) => line.length > 0)
  const entries = lines.map((line) => parseRecord(line))
  if (entries.some((entry) => entry === null)) return { kind: "invalid" }
  const migrated = entries.map((entry) => {
    if (entry === null) return null
    if (entry.schemaVersion === 2) {
      return acceptanceEventV2Schema.safeParse(entry).success ? entry : null
    }
    const parsed = acceptanceEventSchema.safeParse(entry)
    if (!parsed.success) return null
    const identity = identityFor(
      identities,
      parsed.data.runId,
      parsed.data.actualAgentId,
      parsed.data.workerRole,
    )
    return identity === null
      ? null
      : {
          ...parsed.data,
          schemaVersion: 2,
          taskId: identity.taskId,
          role: identity.role,
          semanticAttempt: 1,
        }
  })
  if (migrated.some((entry) => entry === null)) return { kind: "invalid" }
  return {
    kind: entries.every((entry) => entry?.schemaVersion === 2) ? "current" : "migrated",
    bytes:
      migrated.length === 0 ? "" : `${migrated.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  }
}

export function migrateLifecycleRecord(
  path: string,
  bytes: string,
  identities: readonly TaskIdentity[],
): MigrationRecordResult {
  if (path.endsWith(".wal.jsonl")) return migrateWal(bytes, identities)
  const value = parseRecord(bytes)
  if (value === null) return { kind: "invalid" }
  if (path === "active.json") {
    if (currentV2(omit(value, ["migrationRevision"]), activeIndexSchema))
      return { kind: "current", bytes }
    if (!activeIndexSchema.safeParse(value).success) return { kind: "invalid" }
    return {
      kind: "migrated",
      bytes: JSON.stringify({ ...value, schemaVersion: 2, migrationRevision: 1 }),
    }
  }
  if (path.startsWith("runs/")) {
    if (currentV2(omit(value, ["packetHash", "expectedHead"]), runSchema))
      return { kind: "current", bytes }
    if (!runSchema.safeParse(value).success) return { kind: "invalid" }
    return {
      kind: "migrated",
      bytes: JSON.stringify({ ...value, schemaVersion: 2, packetHash: null, expectedHead: null }),
    }
  }
  if (path.startsWith("events/")) {
    if (stateEventV2Schema.safeParse(value).success) return { kind: "current", bytes }
    const parsedEvent = stateEventSchema.safeParse(value)
    if (!parsedEvent.success) return { kind: "invalid" }
    const event = parsedEvent.data
    const taskScoped =
      event.kind === "plan_reconciled" ||
      event.kind === "goal_cycle_started" ||
      event.kind === "criterion_failure_recorded"
    const orderedTaskId =
      event.mutation.kind === "plan_reconciled"
        ? (event.mutation.taskIds[0] ?? null)
        : event.mutation.kind === "goal_cycle_started"
          ? event.mutation.goalId
          : event.mutation.kind === "criterion_failure_recorded"
            ? event.mutation.criterionId
            : null
    const eventIdentities = identities.filter(
      (identity) => identity.runId === event.runId && identity.taskId === orderedTaskId,
    )
    if (taskScoped && eventIdentities.length !== 1) return { kind: "invalid" }
    return {
      kind: "migrated",
      bytes: JSON.stringify({
        ...value,
        schemaVersion: 2,
        expected: {
          ...event.expected,
          expectedHead: null,
          taskGeneration: taskScoped ? 1 : null,
        },
        legacyHeadUnbound: true,
      }),
    }
  }
  if (path.startsWith("task-facts/")) {
    if (currentV2(omit(value, ["packetHash", "tier", "reservationId"]), taskLedgerSchema))
      return { kind: "current", bytes }
    if (!taskLedgerSchema.safeParse(value).success) return { kind: "invalid" }
    return {
      kind: "migrated",
      bytes: JSON.stringify({
        ...value,
        schemaVersion: 2,
        packetHash: null,
        tier: null,
        reservationId: null,
      }),
    }
  }
  if (path.startsWith("worker-acceptance/")) return migrateAcceptance(value, identities)
  if (path.startsWith("worker-rejections/")) return migrateRejections(value, identities)
  if (path.startsWith("teams/")) {
    const v2Team =
      schemaVersion(value) === 2 && value.status === "bound"
        ? { ...omit(value, ["schemaVersion"]), schemaVersion: 1, status: "active" }
        : { ...omit(value, ["schemaVersion"]), schemaVersion: 1 }
    if (schemaVersion(value) === 2 && TeamStateSchema.safeParse(v2Team).success)
      return { kind: "current", bytes }
    if (
      schemaVersion(value) === 2 &&
      TombstoneSchema.safeParse({ ...omit(value, ["schemaVersion"]), schemaVersion: 1 }).success
    )
      return { kind: "current", bytes }
    if (schemaVersion(value) !== 1) return { kind: "invalid" }
    if (TombstoneSchema.safeParse(value).success)
      return { kind: "migrated", bytes: JSON.stringify({ ...value, schemaVersion: 2 }) }
    const parsed = TeamStateSchema.safeParse(value)
    if (!parsed.success) return { kind: "invalid" }
    return {
      kind: "migrated",
      bytes: JSON.stringify({
        ...value,
        schemaVersion: 2,
        status: value.status === "active" ? "bound" : value.status,
      }),
    }
  }
  if (
    path.startsWith("directive-activations/") ||
    path.startsWith("continuation-counters/") ||
    path.startsWith("model-chain-provenance/")
  ) {
    const version = schemaVersion(value)
    if (version === 2) return { kind: "current", bytes }
    if (version !== 1) return { kind: "invalid" }
    return { kind: "migrated", bytes: JSON.stringify({ ...value, schemaVersion: 2 }) }
  }
  return { kind: "invalid" }
}

export function identitiesFromTaskFacts(
  bytes: readonly { readonly path: string; readonly bytes: string }[],
): readonly TaskIdentity[] | null {
  const identities: TaskIdentity[] = []
  for (const item of bytes) {
    if (!item.path.startsWith("task-facts/")) continue
    const value = parseRecord(item.bytes)
    if (value === null) return null
    const source =
      schemaVersion(value) === 2
        ? { ...omit(value, ["packetHash", "tier", "reservationId"]), schemaVersion: 1 }
        : value
    const parsed = taskIdentities(source)
    if (parsed === null) return null
    identities.push(...parsed)
  }
  return identities
}

export function isFutureLifecycleRecord(bytes: string): boolean {
  return bytes
    .split("\n")
    .filter((line) => line.length > 0)
    .some((line) => {
      const value = parseRecord(line)
      return value !== null && typeof value.schemaVersion === "number" && value.schemaVersion > 2
    })
}
