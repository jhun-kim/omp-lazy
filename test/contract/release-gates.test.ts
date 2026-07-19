import { describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { releaseGatePlan, verifyReleaseGateOutput } from "../../scripts/release-gates"

const root = join(import.meta.dir, "..", "..")

describe("authoritative release gate plan", () => {
  it("keeps source, staged, and hostile gates mandatory on Windows", () => {
    // Given
    const platform = "win32"

    // When
    const scripts = releaseGatePlan(platform).map((gate) => gate.script)

    // Then
    expect(scripts).toEqual([
      "check",
      "verify:skills",
      "verify:readme",
      "smoke:loader",
      "smoke:discovery",
      "pack:candidate",
      "smoke:staged",
      "test:hostile",
      "preflight:omp",
      "smoke:link:windows",
    ])
  })

  it("uses pinned host dogfood on non-Windows release hosts", () => {
    // Given
    const platform = "linux"

    // When
    const scripts = releaseGatePlan(platform).map((gate) => gate.script)

    // Then
    expect(scripts.at(-1)).toBe("dogfood:omp")
    expect(scripts).not.toContain("smoke:link:windows")
  })

  it("rejects an empty staged receipt even when its process exits zero", () => {
    // Given
    const output = { exitCode: 0, stderr: "", stdout: "" }

    // When
    const verify = () => verifyReleaseGateOutput("smoke:staged", output)

    // Then
    expect(verify).toThrow("release gate emitted empty evidence: smoke:staged")
  })

  it("does not forward raw gate output through the public release CLI", async () => {
    // Given: a package whose first release gate emits private host metadata.
    const sandbox = await mkdtemp(join(tmpdir(), "omp-lazy-release-log-"))
    const sensitive = "C:\\Users\\maintainer\\private-checkout"
    await writeFile(
      join(sandbox, "package.json"),
      JSON.stringify({
        scripts: { check: `bun -e ${JSON.stringify(`console.log(${JSON.stringify(sensitive)})`)}` },
      }),
    )

    try {
      // When: the unmodified release CLI runs against that package.
      const result = Bun.spawnSync({
        cmd: ["bun", join(root, "scripts", "verify-release.ts")],
        cwd: sandbox,
        stderr: "pipe",
        stdout: "pipe",
      })
      const stdout = new TextDecoder().decode(result.stdout)

      // Then: only the public gate summary is emitted before the next missing gate fails.
      expect(result.exitCode).not.toBe(0)
      expect(stdout).toBe("PASS check\n")
      expect(stdout).not.toContain(sensitive)
    } finally {
      await rm(sandbox, { force: true, recursive: true })
    }
  })
})
