import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  copyCandidate,
  removeCandidate,
  repositoryRoot,
  run,
  writeJson,
} from "../fixtures/package-test-helpers"

const candidates: string[] = []

afterEach(async () => Promise.all(candidates.splice(0).map(removeCandidate)))

describe("forbidden runtime dependencies", () => {
  it("rejects a runtime host dependency", async () => {
    // Given: a candidate that declares OMP as a runtime dependency.
    const candidate = await copyCandidate("runtime-host")
    candidates.push(candidate)
    const manifest = JSON.parse(await readFile(join(candidate, "package.json"), "utf8"))
    manifest.dependencies = { "@oh-my-pi/pi-coding-agent": "16.4.8" }
    await writeJson(join(candidate, "package.json"), manifest)

    // When: the package inspector evaluates the candidate.
    const result = run([
      "bun",
      "scripts/pack-candidate.ts",
      "--candidate",
      candidate,
      "--mode",
      "inspect",
    ])

    // Then: a second runtime host tree is refused.
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("runtime dependency")
  })

  it("rejects absolute cache and Codex runtime references", async () => {
    // Given: runtime source containing both forbidden lookup classes.
    const candidate = await copyCandidate("runtime-path")
    candidates.push(candidate)
    await mkdir(join(candidate, "src"), { recursive: true })
    await writeFile(
      join(candidate, "src", "bad.ts"),
      'export const bad = "CODEX_HOME C:\\\\Users\\\\user\\\\.codex\\\\cache"\n',
    )

    // When: the package inspector scans runtime files.
    const result = run([
      "bun",
      "scripts/pack-candidate.ts",
      "--candidate",
      candidate,
      "--mode",
      "inspect",
    ])

    // Then: cache/source lookup cannot enter distributable runtime code.
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("forbidden runtime reference")
    expect(repositoryRoot).not.toContain("node_modules/@oh-my-pi")
  })
})
