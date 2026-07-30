import { describe, expect, it } from "bun:test"
import { threatManifest } from "../../scripts/threat-manifest"

describe("threat manifest", () => {
  it("maps every G01-G29 risk to an independent oracle and attestor", () => {
    // Given
    const expectedIds = Array.from(
      { length: 29 },
      (_, index) => `G${String(index + 1).padStart(2, "0")}`,
    )

    // When
    const ids = threatManifest.scenarios.map((scenario) => scenario.id)

    // Then
    expect(ids.join(",")).toBe(expectedIds.join(","))
    for (const scenario of threatManifest.scenarios) {
      expect(scenario.attestors.length).toBeGreaterThan(0)
      expect(scenario.attestors).not.toContain(scenario.executor)
      expect(scenario.executor).toMatch(/^E-/)
      expect(scenario.timeoutMs).toBeGreaterThan(0)
      expect(scenario.risk.trim().length).toBeGreaterThan(0)
      expect(scenario.oracle.length).toBeGreaterThan(10)
      expect(scenario.forbiddenSideEffects.length).toBeGreaterThan(0)
      expect(scenario.evidencePath.startsWith(".omo/evidence/")).toBe(true)
    }
  })
})
