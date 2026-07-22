import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { type LockCode, validateClosureLock } from "../../harness-eval/src/closure-lock"

const manifestPath = join("harness-eval", "manifest.v1.json")
const schemaPath = join("harness-eval", "live-profile-input.schema.v1.json")
const lockPath = "harness-eval.lock.json"

type LockMutation = {
  readonly code: LockCode
  readonly field: string
  readonly value: string
}

const lockMutations: readonly LockMutation[] = [
  { code: "closure_commit_mismatch", field: "closureCommit", value: "0".repeat(40) },
  { code: "closure_tree_mismatch", field: "closureTreeHash", value: "0".repeat(40) },
  { code: "baseline_mismatch", field: "baselineTargetCommit", value: "0".repeat(40) },
  { code: "manifest_hash_mismatch", field: "manifestSha256", value: "0".repeat(64) },
  {
    code: "live_schema_hash_mismatch",
    field: "liveProfileInputSchemaSha256",
    value: "0".repeat(64),
  },
]

async function writeMutatedLock(root: string, mutation: LockMutation): Promise<string> {
  const lock = JSON.parse(await readFile(lockPath, "utf8"))
  lock[mutation.field] = mutation.value
  const path = join(root, "harness-eval.lock.json")
  await writeFile(path, JSON.stringify(lock))
  return path
}

function git(arguments_: readonly string[], cwd: string): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...arguments_])
  if (result.exitCode !== 0) throw new TypeError(new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}

describe("harness evaluator closure lock", () => {
  for (const mutation of lockMutations) {
    it(`rejects ${mutation.field} mutation with ${mutation.code}`, async () => {
      // Given a strictly valid lock with one authority binding altered
      const root = await mkdtemp(join(tmpdir(), "omp-lazy-closure-lock-"))
      const mutatedLockPath = await writeMutatedLock(root, mutation)

      try {
        // When canonical lock validation reads the altered lock
        const receipt = await validateClosureLock(manifestPath, { lockPath: mutatedLockPath })

        // Then the stable authority rejection prevents deterministic PASS
        expect(receipt).toEqual({ code: mutation.code, status: "FAIL" })
      } finally {
        await rm(root, { force: true, recursive: true })
      }
    })
  }

  it("rejects lock schema drift and current committed subtree drift", async () => {
    // Given a detached worktree whose lock initially binds its committed evaluator subtree
    const root = await mkdtemp(join(tmpdir(), "omp-lazy-closure-worktree-"))
    const worktree = join(root, "checkout")
    git(["worktree", "add", "--detach", worktree, "HEAD"], process.cwd())

    try {
      const malformedLockPath = join(root, "malformed.lock.json")
      const lock = JSON.parse(await readFile(lockPath, "utf8"))
      await writeFile(malformedLockPath, JSON.stringify({ ...lock, unexpected: true }))
      expect(
        await validateClosureLock(join(worktree, manifestPath), {
          gitCwd: worktree,
          lockPath: malformedLockPath,
          schemaPath: join(worktree, schemaPath),
        }),
      ).toEqual({ code: "closure_lock_invalid", status: "FAIL" })

      await cp(lockPath, join(worktree, lockPath))
      await writeFile(join(worktree, "harness-eval", ".subtree-drift"), "drift\n")
      git(["add", "harness-eval/.subtree-drift"], worktree)
      git(
        [
          "-c",
          "user.name=Harness Test",
          "-c",
          "user.email=harness-test@example.invalid",
          "commit",
          "-m",
          "test: alter evaluator subtree",
        ],
        worktree,
      )

      // When a later HEAD changes the committed evaluator subtree
      const receipt = await validateClosureLock(join(worktree, manifestPath), {
        gitCwd: worktree,
        lockPath: join(worktree, lockPath),
        schemaPath: join(worktree, schemaPath),
      })

      // Then the two-stage lock permits only unchanged later subtrees
      expect(receipt).toEqual({ code: "current_subtree_mismatch", status: "FAIL" })
    } finally {
      git(["worktree", "remove", "--force", worktree], process.cwd())
      await rm(root, { force: true, recursive: true })
    }
  })

  it("rejects a mutated lock through the canonical verify CLI path", async () => {
    // Given a detached checkout with a malformed closure commit lock binding
    const root = await mkdtemp(join(tmpdir(), "omp-lazy-closure-cli-"))
    const worktree = join(root, "checkout")
    git(["worktree", "add", "--detach", worktree, "HEAD"], process.cwd())

    try {
      const lock = JSON.parse(await readFile(lockPath, "utf8"))
      await writeFile(
        join(worktree, lockPath),
        JSON.stringify({ ...lock, closureCommit: "0".repeat(40) }),
      )
      const child = Bun.spawn(
        [
          "bun",
          resolve(import.meta.dir, "../../harness-eval/src/cli.ts"),
          "verify",
          "--manifest",
          manifestPath,
          "--target-commit",
          "HEAD",
        ],
        { cwd: worktree, stderr: "pipe", stdout: "pipe" },
      )

      // When the supported canonical verify invocation evaluates the lock
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])

      // Then lock attestation fails before any unavailable execution corpus can mask it
      expect(stderr).toBe("")
      expect(exitCode).toBe(1)
      expect(JSON.parse(stdout)).toEqual({ code: "closure_commit_mismatch", status: "FAIL" })
    } finally {
      git(["worktree", "remove", "--force", worktree], process.cwd())
      await rm(root, { force: true, recursive: true })
    }
  })

  it("rejects a manifest that points at a different live-schema hash", async () => {
    // Given manifest bytes whose self-declared schema hash diverges from the locked schema bytes
    const root = await mkdtemp(join(tmpdir(), "omp-lazy-closure-manifest-"))
    const changedManifestPath = join(root, "manifest.v1.json")
    const changedLockPath = join(root, "harness-eval.lock.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    const manifestBytes = `${JSON.stringify({
      ...manifest,
      liveProfileInputSchemaSha256: "0".repeat(64),
    })}\n`
    const lock = JSON.parse(await readFile(lockPath, "utf8"))
    await writeFile(changedManifestPath, manifestBytes)
    await writeFile(
      changedLockPath,
      JSON.stringify({
        ...lock,
        manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      }),
    )

    try {
      // When lock validation verifies both the manifest declaration and schema bytes
      const receipt = await validateClosureLock(changedManifestPath, { lockPath: changedLockPath })

      // Then a stale manifest schema binding cannot inherit the lock's PASS
      expect(receipt).toEqual({ code: "live_schema_hash_mismatch", status: "FAIL" })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
