import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { manifestSchema } from "./schema"

const gitHash = z.string().regex(/^[a-f0-9]{40,64}$/)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const lockSchema = z
  .object({
    schemaVersion: z.literal(1),
    closureCommit: gitHash,
    closureTreeHash: gitHash,
    baselineTargetCommit: gitHash,
    baselineTargetTree: gitHash,
    manifestSha256: sha256,
    liveProfileInputSchemaSha256: sha256,
  })
  .strict()

export type LockCode =
  | "closure_lock_invalid"
  | "closure_commit_mismatch"
  | "closure_tree_mismatch"
  | "current_subtree_mismatch"
  | "baseline_mismatch"
  | "manifest_hash_mismatch"
  | "live_schema_hash_mismatch"

type LockReceipt =
  | { readonly status: "PASS" }
  | { readonly code: LockCode; readonly status: "FAIL" }

export type ClosureLockValidationOptions = {
  readonly gitCwd?: string
  readonly lockPath?: string
  readonly schemaPath?: string
}

function git(arguments_: readonly string[], cwd: string): string | undefined {
  const result = Bun.spawnSync(["git", "-C", cwd, ...arguments_])
  return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : undefined
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    return undefined
  }
}

export async function validateClosureLock(
  manifestPath: string,
  options: ClosureLockValidationOptions = {},
): Promise<LockReceipt> {
  const gitCwd = options.gitCwd ?? process.cwd()
  const repositoryRoot = git(["rev-parse", "--show-toplevel"], gitCwd)
  if (repositoryRoot === undefined) return { code: "closure_commit_mismatch", status: "FAIL" }
  const lockPath = options.lockPath ?? join(repositoryRoot, "harness-eval.lock.json")
  const schemaPath =
    options.schemaPath ?? join(repositoryRoot, "harness-eval", "live-profile-input.schema.v1.json")
  const parsedLock = lockSchema.safeParse(await readJson(lockPath))
  if (!parsedLock.success) return { code: "closure_lock_invalid", status: "FAIL" }
  const lock = parsedLock.data
  if (
    git(["rev-parse", "--verify", `${lock.closureCommit}^{commit}`], gitCwd) !== lock.closureCommit
  ) {
    return { code: "closure_commit_mismatch", status: "FAIL" }
  }
  if (git(["rev-parse", `${lock.closureCommit}:harness-eval`], gitCwd) !== lock.closureTreeHash) {
    return { code: "closure_tree_mismatch", status: "FAIL" }
  }
  if (git(["rev-parse", "HEAD:harness-eval"], gitCwd) !== lock.closureTreeHash) {
    return { code: "current_subtree_mismatch", status: "FAIL" }
  }
  if (
    git(["rev-parse", `${lock.baselineTargetCommit}^{tree}`], gitCwd) !== lock.baselineTargetTree
  ) {
    return { code: "baseline_mismatch", status: "FAIL" }
  }
  let manifestBytes: Uint8Array
  try {
    manifestBytes = await readFile(manifestPath)
  } catch {
    return { code: "manifest_hash_mismatch", status: "FAIL" }
  }
  if (digest(manifestBytes) !== lock.manifestSha256) {
    return { code: "manifest_hash_mismatch", status: "FAIL" }
  }
  const manifest = manifestSchema.safeParse(await readJson(manifestPath))
  if (!manifest.success) return { code: "manifest_hash_mismatch", status: "FAIL" }
  if (
    manifest.data.baselineTargetCommit !== lock.baselineTargetCommit ||
    manifest.data.baselineTargetTree !== lock.baselineTargetTree
  ) {
    return { code: "baseline_mismatch", status: "FAIL" }
  }
  if (manifest.data.liveProfileInputSchemaSha256 !== lock.liveProfileInputSchemaSha256) {
    return { code: "live_schema_hash_mismatch", status: "FAIL" }
  }
  let schemaBytes: Uint8Array
  try {
    schemaBytes = await readFile(schemaPath)
  } catch {
    return { code: "live_schema_hash_mismatch", status: "FAIL" }
  }
  return digest(schemaBytes) === lock.liveProfileInputSchemaSha256
    ? { status: "PASS" }
    : { code: "live_schema_hash_mismatch", status: "FAIL" }
}
