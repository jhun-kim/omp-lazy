import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { ompCommand } from "../../scripts/omp-executable"
import { createOmpExecutableStub } from "../fixtures/create-omp-executable-stub"
import { repositoryRoot, run } from "../fixtures/package-test-helpers"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

describe("real OMP executable preflight", () => {
  it("rejects OMP 17 before profile commands run", async () => {
    // Given: a deterministic OMP 17 executable fixture and disposable profile roots.
    const root = await mkdtemp(join(repositoryRoot, ".t13 real omp "))
    roots.push(root)
    const fixture = await createOmpExecutableStub(root)
    const profile = join(root, "Disposable Profile")
    const temp = join(root, "Disposable Temp")
    await mkdir(profile, { recursive: true })
    await mkdir(temp, { recursive: true })

    // When: the preflight receives the explicit executable path.
    const result = run(
      ["bun", "scripts/preflight-real-omp.ts", "--omp-exe", fixture.executable],
      repositoryRoot,
      { PI_CODING_AGENT_DIR: profile, TEMP: temp, TMP: temp },
    )

    // Then: version rejection is distinct and happens before profile command writes.
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("unsupported_host_version")
    expect(result.stderr).toContain("expected OMP 16.4.8, received omp/17.0.2")
    await expect(readFile(fixture.argvLog, "utf8")).rejects.toThrow()
    await expect(readFile(join(profile, "models.yml"), "utf8")).rejects.toThrow()
  })

  it("reports a missing executable distinctly", async () => {
    // Given: an explicit executable path that does not exist.
    const root = await mkdtemp(join(repositoryRoot, ".t13 missing omp "))
    roots.push(root)
    const missing = join(root, "OMP Runtime With Spaces", "missing.cmd")

    // When: preflight resolves the literal executable path.
    const result = run(["bun", "scripts/preflight-real-omp.ts", "--omp-exe", missing])

    // Then: missing executable failure is not conflated with version mismatch.
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("missing_executable")
    expect(result.stderr).toContain("OMP executable not found")
    expect(result.stderr).toContain(missing)
  })

  it("preserves a path with spaces as one post-version argv item", async () => {
    const root = await mkdtemp(join(repositoryRoot, ".t13 spaced argv "))
    roots.push(root)
    const fixture = await createOmpExecutableStub(root)
    const candidate = join(root, "Candidate With Spaces")

    const result = run(ompCommand(fixture.executable, ["plugin", "link", candidate, "--json"]))

    expect(result.exitCode).not.toBe(0)
    const lines = (await readFile(fixture.argvLog, "utf8")).trim().split("\n")
    expect(lines).toHaveLength(1)
    expect(z.array(z.string()).parse(JSON.parse(lines[0] ?? "null"))).toEqual([
      "plugin",
      "link",
      candidate,
      "--json",
    ])
  })
})
