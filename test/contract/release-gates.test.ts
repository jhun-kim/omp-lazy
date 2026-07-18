import { describe, expect, it } from "bun:test"
import { releaseGatePlan, verifyReleaseGateOutput } from "../../scripts/release-gates"

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
})
