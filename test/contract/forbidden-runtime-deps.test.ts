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
    manifest.dependencies = { "@oh-my-pi/pi-coding-agent": "17.0.5" }
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

  it("accepts Zod as the only required runtime dependency", async () => {
    // Given: production runtime modules import Zod schemas.
    const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"))

    // When: runtime dependencies are inspected.
    const dependencies = manifest.dependencies

    // Then: Zod is shipped for runtime imports while the OMP host remains external.
    expect(dependencies).toEqual({ zod: "4.4.3" })
    expect(dependencies["@oh-my-pi/pi-coding-agent"]).toBeUndefined()
  })

  it("rejects a candidate missing runtime Zod", async () => {
    // Given: a candidate whose runtime package metadata omits Zod.
    const candidate = await copyCandidate("missing-runtime-zod")
    candidates.push(candidate)
    const manifest = JSON.parse(await readFile(join(candidate, "package.json"), "utf8"))
    manifest.dependencies = {}
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

    // Then: runtime Zod is required because packed source imports it.
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("missing runtime dependency: zod")
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
