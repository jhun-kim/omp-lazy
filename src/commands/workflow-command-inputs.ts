import { createHash } from "node:crypto"
import { readFile, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { z } from "zod"
import { atomicReplace } from "../state/atomic-file"
import { canonicalComparisonPath, isDisplayPathContained } from "../state/paths"
import { deadlineAfter } from "../state/repo-lock"
import type { TransactionStore } from "../state/transaction-store"
import { type NormalizedPlan, normalizeStartWorkPlan } from "../workflows/start-work-plan"
import { type TeamDefinition, TeamDefinitionSchema } from "../workflows/teammode-domain"

const hashSchema = z.string().regex(/^[0-9a-f]{64}$/)
const approvalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  planHash: hashSchema,
  approverSessionHash: hashSchema,
  ownerEpoch: z.number().int().positive(),
  planRevision: z.number().int().positive(),
  approvalRecordHash: hashSchema,
})
const steeringSchema = z.strictObject({
  version: z.literal(1),
  runId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
  expectedHead: z.string().regex(/^[0-9a-f]{40}$/),
  idempotencyKey: z.string().trim().min(1).max(128),
  addCriteria: z
    .array(
      z.strictObject({
        id: z.string().trim().min(1).max(64),
        scenario: z.string().trim().min(1).max(1_024),
        observable: z.string().trim().min(1).max(1_024),
        evidenceLogicalId: z.string().trim().min(1).max(128),
      }),
    )
    .max(6)
    .readonly(),
  annotation: z.string().max(512).optional(),
})

export type ContainedPlan = {
  readonly canonicalPath: string
  readonly displayPath: string
  readonly hash: string
  readonly normalized: NormalizedPlan
}
export type SteeringInput = z.infer<typeof steeringSchema>
export type InputResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string }

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

async function containedFile(input: {
  readonly store: TransactionStore
  readonly path: string
  readonly allowedRoot: string
  readonly maximumBytes: number
}): Promise<InputResult<{ readonly bytes: string; readonly displayPath: string }>> {
  const { store, path, allowedRoot, maximumBytes } = input
  if (isAbsolute(path)) return { ok: false, code: "path_outside_repository" }
  const candidate = resolve(store.root.displayPath, path)
  if (!isDisplayPathContained(allowedRoot, candidate)) {
    return { ok: false, code: "path_outside_repository" }
  }
  try {
    const resolved = await realpath(candidate)
    if (!isDisplayPathContained(allowedRoot, resolved)) {
      return { ok: false, code: "path_outside_repository" }
    }
    const bytes = await readFile(resolved, "utf8")
    return Buffer.byteLength(bytes) > maximumBytes
      ? { ok: false, code: "malformed_payload" }
      : { ok: true, value: { bytes, displayPath: resolved } }
  } catch (error) {
    if (error instanceof Error) return { ok: false, code: "resource_missing" }
    throw error
  }
}

export async function readContainedPlan(
  store: TransactionStore,
  path: string,
): Promise<InputResult<ContainedPlan>> {
  const planRoot = join(store.root.displayPath, ".omo", "plans")
  const file = await containedFile({
    store,
    path,
    allowedRoot: planRoot,
    maximumBytes: 2 * 1_024 * 1_024,
  })
  if (!file.ok) return file
  const normalized = normalizeStartWorkPlan(file.value.bytes)
  if (!normalized.ok) return normalized
  return {
    ok: true,
    value: {
      canonicalPath: canonicalComparisonPath(file.value.displayPath),
      displayPath: file.value.displayPath,
      hash: sha256(file.value.bytes),
      normalized: normalized.value,
    },
  }
}

function approvalPath(store: TransactionStore, planHash: string): string {
  return join(store.paths.root, "approvals", `${planHash}.json`)
}

export async function approvePlan(input: {
  readonly store: TransactionStore
  readonly sessionId: string
  readonly path: string
  readonly claimedHash: string
}): Promise<InputResult<ContainedPlan>> {
  const { store, sessionId, path, claimedHash } = input
  const plan = await readContainedPlan(store, path)
  if (!plan.ok) return plan
  if (plan.value.hash !== claimedHash) return { ok: false, code: "plan_identity_mismatch" }
  const base = {
    schemaVersion: 1 as const,
    planHash: plan.value.hash,
    approverSessionHash: sha256(sessionId),
    ownerEpoch: 1,
    planRevision: 1,
  }
  const candidate = approvalSchema.parse({
    ...base,
    approvalRecordHash: sha256(JSON.stringify(base)),
  })
  const target = approvalPath(store, plan.value.hash)
  await store.guard(target)
  const deadline = deadlineAfter(2_000)
  const handle = await store.lock.tryAcquire({
    deadline,
    purpose: "command",
    sessionId,
    maxWaitMs: Math.min(2_000, deadline.remainingMs()),
  })
  if (handle === null) return { ok: false, code: "state_conflict" }
  try {
    try {
      const existing = approvalSchema.parse(JSON.parse(await readFile(target, "utf8")))
      return JSON.stringify(existing) === JSON.stringify(candidate)
        ? plan
        : { ok: false, code: "idempotency_conflict" }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
    await atomicReplace(target, JSON.stringify(candidate), { deadline, guard: store.guard })
    return plan
  } finally {
    await handle.release()
  }
}

export async function planIsApproved(
  store: TransactionStore,
  sessionId: string,
  planHash: string,
): Promise<boolean> {
  try {
    const approval = approvalSchema.parse(
      JSON.parse(await readFile(approvalPath(store, planHash), "utf8")),
    )
    return approval.approverSessionHash === sha256(sessionId)
  } catch (error) {
    if (error instanceof Error) return false
    throw error
  }
}

export async function readSteeringInput(
  store: TransactionStore,
  path: string,
): Promise<InputResult<SteeringInput>> {
  const file = await containedFile({
    store,
    path,
    allowedRoot: store.root.displayPath,
    maximumBytes: 16 * 1_024,
  })
  if (!file.ok) return file
  try {
    const parsed = steeringSchema.safeParse(JSON.parse(file.value.bytes))
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, code: "malformed_payload" }
  } catch (error) {
    if (error instanceof SyntaxError) return { ok: false, code: "malformed_payload" }
    throw error
  }
}

export async function readTeamDefinition(
  store: TransactionStore,
  path: string,
): Promise<InputResult<TeamDefinition>> {
  const file = await containedFile({
    store,
    path,
    allowedRoot: store.root.displayPath,
    maximumBytes: 64 * 1_024,
  })
  if (!file.ok) return file
  try {
    const parsed = TeamDefinitionSchema.safeParse(JSON.parse(file.value.bytes))
    if (parsed.success) return { ok: true, value: parsed.data }
    return {
      ok: false,
      code: parsed.error.issues.some((issue) => issue.message === "member ownership overlaps")
        ? "ownership_overlap"
        : "malformed_payload",
    }
  } catch (error) {
    if (error instanceof SyntaxError) return { ok: false, code: "malformed_payload" }
    throw error
  }
}

export function repositoryRelativePath(store: TransactionStore, displayPath: string): string {
  return relative(store.root.displayPath, displayPath).replaceAll("\\", "/")
}
