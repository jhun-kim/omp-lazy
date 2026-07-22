import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { GitEvidenceBinding } from "../contracts/git-evidence-binding"
import { atomicReplace } from "../state/atomic-file"
import type { AnyRun } from "../state/domain"
import { deadlineAfter } from "../state/repo-lock"
import type { TransactionStore } from "../state/transaction-store"
import {
  matchesTeamDefinition,
  type TeamDefinition,
  TeamDefinitionSchema,
  TeamNameSchema,
  type TeamState,
  TeamStateSchema,
} from "../workflows/teammode-domain"
import { TeammodeStateStore } from "../workflows/teammode-state-store"

const reservationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  reservationId: z.string().regex(/^[0-9a-f]{64}$/),
  teamName: TeamNameSchema,
  runId: z.uuid(),
  ownerSessionId: z.string().trim().min(1),
  ownerEpoch: z.number().int().positive(),
  expectedHead: z.string().regex(/^[0-9a-f]{40}$/),
  definition: TeamDefinitionSchema,
  consumed: z.boolean(),
})

type TeamReservation = z.infer<typeof reservationSchema>
type GitEvidenceFailureCode = Extract<GitEvidenceBinding, { readonly ok: false }>["code"]
type TeamReservationFailureCode =
  | GitEvidenceFailureCode
  | "state_conflict"
  | "idempotency_conflict"
  | "missing_target"
  | "owner_mismatch"
  | "owner_epoch_mismatch"
  | "stale_head"
export type TeamReservationResult =
  | { readonly ok: true; readonly reservationId: string; readonly state?: TeamState }
  | { readonly ok: false; readonly code: TeamReservationFailureCode }

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function reservationPath(store: TransactionStore, teamName: string): string {
  return join(store.paths.root, "team-reservations", `${teamName}.json`)
}

async function readReservation(
  store: TransactionStore,
  teamName: string,
): Promise<TeamReservation | null> {
  const path = reservationPath(store, teamName)
  await store.guard(path)
  try {
    return reservationSchema.parse(JSON.parse(await readFile(path, "utf8")))
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  }
}

function candidateReservation(
  run: AnyRun,
  definition: TeamDefinition,
  expectedHead: string,
): TeamReservation {
  const semantic = {
    teamName: definition.teamName,
    runId: run.runId,
    ownerSessionId: run.owner.sessionId,
    ownerEpoch: run.owner.epoch,
    expectedHead,
    definition,
  }
  return reservationSchema.parse({
    schemaVersion: 1,
    reservationId: sha256(JSON.stringify(semantic)),
    ...semantic,
    consumed: false,
  })
}

export async function prepareTeamReservation(input: {
  readonly store: TransactionStore
  readonly run: AnyRun
  readonly definition: TeamDefinition
  readonly expectedHead: string
}): Promise<TeamReservationResult> {
  const { store, run, definition, expectedHead } = input
  const deadline = deadlineAfter(2_000)
  const handle = await store.lock.tryAcquire({
    deadline,
    purpose: "command",
    sessionId: run.owner.sessionId,
    maxWaitMs: Math.min(2_000, deadline.remainingMs()),
  })
  if (handle === null) return { ok: false, code: "state_conflict" }
  try {
    const candidate = candidateReservation(run, definition, expectedHead)
    const existing = await readReservation(store, definition.teamName)
    if (existing !== null) {
      return existing.reservationId === candidate.reservationId
        ? { ok: true, reservationId: existing.reservationId }
        : { ok: false, code: "idempotency_conflict" }
    }
    await atomicReplace(reservationPath(store, definition.teamName), JSON.stringify(candidate), {
      deadline,
      guard: store.guard,
    })
    return { ok: true, reservationId: candidate.reservationId }
  } finally {
    await handle.release()
  }
}

export async function consumeTeamReservation(input: {
  readonly store: TransactionStore
  readonly callerSessionId: string
  readonly teamName: string
  readonly reservationId: string
  readonly readGit: () => Promise<GitEvidenceBinding>
}): Promise<TeamReservationResult> {
  const { store, callerSessionId, teamName, reservationId, readGit } = input
  const deadline = deadlineAfter(2_000)
  const handle = await store.lock.tryAcquire({
    deadline,
    purpose: "command",
    sessionId: callerSessionId,
    maxWaitMs: Math.min(2_000, deadline.remainingMs()),
  })
  if (handle === null) return { ok: false, code: "state_conflict" }
  try {
    const reservation = await readReservation(store, teamName)
    if (reservation === null) return { ok: false, code: "missing_target" }
    if (reservation.reservationId !== reservationId) {
      return { ok: false, code: "idempotency_conflict" }
    }
    const run = await store.readRun(reservation.runId, false)
    if (run === null) return { ok: false, code: "missing_target" }
    if (run.owner.sessionId !== callerSessionId) {
      return { ok: false, code: "owner_mismatch" }
    }
    if (run.owner.epoch !== reservation.ownerEpoch) {
      return { ok: false, code: "owner_epoch_mismatch" }
    }
    if (run.schemaVersion !== 2 || run.expectedHead !== reservation.expectedHead) {
      return { ok: false, code: "stale_head" }
    }
    const states = new TeammodeStateStore(store)
    const current = await states.read(teamName)
    if (current !== null) {
      return matchesTeamDefinition(current, reservation.definition)
        ? { ok: true, reservationId, state: current }
        : { ok: false, code: "idempotency_conflict" }
    }
    const git = await readGit()
    if (!git.ok) return git
    if (git.head !== reservation.expectedHead) return { ok: false, code: "stale_head" }
    if (reservation.consumed) return { ok: false, code: "idempotency_conflict" }
    const state = TeamStateSchema.parse({
      schemaVersion: 1,
      teamName,
      runId: run.runId,
      attempt: run.progressRevision,
      revision: 1,
      status: "initializing",
      members: reservation.definition.members.map((member) => ({
        ...member,
        actualAgentId: null,
        actualJobId: null,
        worktreePath: null,
        acceptanceKey: null,
      })),
    })
    await states.replace(teamName, state, deadline)
    await atomicReplace(
      reservationPath(store, teamName),
      JSON.stringify({ ...reservation, consumed: true }),
      { deadline, guard: store.guard },
    )
    return { ok: true, reservationId, state }
  } finally {
    await handle.release()
  }
}
