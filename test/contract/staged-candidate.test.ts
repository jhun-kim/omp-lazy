import { afterEach, describe, expect, it } from "bun:test"
import { appendFile, chmod, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expectedProductRuntime } from "../../scripts/product-runtime-contract"
import {
  commitCandidate,
  copyCandidate,
  removeCandidate,
  repositoryRoot,
  run,
} from "../fixtures/package-test-helpers"

const sandboxes: string[] = []

afterEach(async () => Promise.all(sandboxes.splice(0).map(removeCandidate)))

async function builtCandidate(
  prefix: string,
): Promise<{ readonly candidate: string; readonly receipt: unknown }> {
  const candidate = await copyCandidate(prefix)
  sandboxes.push(candidate)
  commitCandidate(candidate)
  const result = run([
    "bun",
    "scripts/pack-candidate.ts",
    "--candidate",
    candidate,
    "--mode",
    "build",
    "--destination",
    join(candidate, ".omo", "evidence", "candidate"),
  ])
  expect(result.exitCode).toBe(0)
  return { candidate, receipt: JSON.parse(result.stdout) }
}

describe("staged candidate proof", () => {
  it("proves a committed tarball through an ordinary installed runtime", async () => {
    // Given: a candidate tarball built from committed package bytes.
    const { candidate, receipt } = await builtCandidate("staged-happy")

    // When: the staged smoke installs and probes the tarball.
    const result = run(["bun", join(repositoryRoot, "scripts", "smoke-staged.ts")], candidate)

    // Then: the installed package is an ordinary directory with exact runtime inventory.
    expect(result.exitCode).toBe(0)
    const staged = JSON.parse(result.stdout)
    expect(staged.installShape).toBe("ordinary-directory")
    expect(staged.cleanup).toEqual({ profile: "complete", sandbox: "complete" })
    expect(staged.sha256).toBe(JSON.parse(JSON.stringify(receipt)).sha256)
    expect(staged.commandNames).toEqual(expectedProductRuntime.commandNames)
    expect(staged.toolNames).toEqual(expectedProductRuntime.toolNames)
    expect(staged.handlerCounts).toEqual(expectedProductRuntime.handlerCounts)
    expect(staged.skillNames).toEqual(expectedProductRuntime.skillNames)
    expect(staged.agentNames).toEqual(expectedProductRuntime.agentNames)
  }, 300_000)

  it("rejects stale source changes after packaging", async () => {
    // Given: a committed candidate is changed after its tarball receipt is written.
    const { candidate } = await builtCandidate("staged-stale")
    await appendFile(join(candidate, "README.md"), "stale source change\n")

    // When: staged verification re-reads the candidate receipt.
    const result = run(["bun", join(repositoryRoot, "scripts", "smoke-staged.ts")], candidate)

    // Then: the source mismatch invalidates the staged proof.
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("candidate worktree changed after packaging")
  }, 300_000)

  it("rejects tampered tarball bytes before installing", async () => {
    // Given: a candidate tarball is mutated after receipt generation.
    const { candidate, receipt } = await builtCandidate("staged-tamper")
    const tarball = JSON.parse(JSON.stringify(receipt)).tarball
    await chmod(tarball, 0o666)
    await appendFile(tarball, "tamper")

    // When: staged verification checks the receipt hash.
    const result = run(["bun", join(repositoryRoot, "scripts", "smoke-staged.ts")], candidate)

    // Then: hash mismatch fails before install or load.
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("candidate tarball hash changed")
  }, 300_000)

  it("rejects a staged install missing its extension entrypoint", async () => {
    // Given: a copied installed package with the declared extension removed.
    const candidate = await copyCandidate("staged-missing-entry")
    sandboxes.push(candidate)
    const project = join(candidate, "project")
    await mkdir(join(project, ".omp"), { recursive: true })
    await writeFile(
      join(project, ".omp", "settings.json"),
      `${JSON.stringify({ extensions: [candidate] })}\n`,
    )
    await rm(join(candidate, "src", "index.ts"))

    // When: the staged runtime probe loads the installed root.
    const result = run(
      [
        "bun",
        "--eval",
        `import { probeStagedRuntime } from "${join(repositoryRoot, "scripts", "staged-runtime-probe.ts").replaceAll("\\", "\\\\")}"; await probeStagedRuntime(${JSON.stringify(candidate)}, ${JSON.stringify(project)})`,
      ],
      repositoryRoot,
    )

    // Then: the missing installed entry cannot be mistaken for a valid package.
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("staged package is missing its declared extension entrypoint")
  }, 300_000)
})
