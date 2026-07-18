import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  HOSTILE_SCENARIO_IDS,
  readHostileScenarioMap,
  type ScenarioId,
} from "../../scripts/hostile-contract"
import { preserveFirstFailure, runEscapingScenario } from "../../scripts/hostile-oracles"
import { runHostileScenario } from "../../scripts/hostile-scenario"
import { replayHostile } from "../../scripts/replay-hostile"
import { threatManifest } from "../../scripts/threat-manifest"

async function temporaryEvidence(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `omp-lazy-${label}-`))
}

describe("bounded hostile replay", () => {
  test("Given the frozen threat registry When loading scenario ownership Then G01-G25 each has tests and an independent bound", async () => {
    // Given
    const expected = Array.from(
      { length: 25 },
      (_, index) => `G${String(index + 1).padStart(2, "0")}`,
    )

    // When
    const map = await readHostileScenarioMap()

    // Then
    expect(HOSTILE_SCENARIO_IDS.join(",")).toBe(expected.join(","))
    expect(Object.keys(map).join(",")).toBe(expected.join(","))
    for (const scenario of threatManifest.scenarios) {
      expect(map[scenario.id].length).toBeGreaterThan(0)
      expect(scenario.executor).toMatch(/^E-/)
      expect(scenario.timeoutMs).toBeGreaterThan(0)
    }
  })

  test("Given one addressed scenario When its owned tests finish Then it records terminal PASS and non-empty raw evidence", async () => {
    // Given
    const root = await temporaryEvidence("hostile-pass")
    const scenario = threatManifest.scenarios.find((candidate) => candidate.id === "G05")
    if (scenario === undefined) throw new TypeError("G05 threat scenario missing")

    try {
      // When
      const result = await runHostileScenario({
        environment: "enabled",
        files: ["test/contract/threat-manifest.test.ts"],
        overallDeadlineAt: performance.now() + 30_000,
        repeat: 1,
        root,
        scenario,
        seed: 1357,
      })

      // Then
      expect(result).toMatchObject({
        cleanup: { processTree: "complete", residue: [], sandbox: "complete" },
        owner: "E-ACT",
        scenarioId: "G05",
        status: "PASS",
      })
      expect(result.process.timedOut).toBeFalse()
      expect(result.rawEvidenceBytes).toBeGreaterThan(0)
      const rawBytes = await Promise.all([
        readFile(resolve(root, result.process.stdout.path)),
        readFile(resolve(root, result.process.stderr.path)),
      ])
      expect(rawBytes.reduce((total, bytes) => total + bytes.byteLength, 0)).toBeGreaterThan(0)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 30_000)

  test("Given a delayed escaping descendant When Windows taskkill or a POSIX-owned group times out Then no late mutation survives", async () => {
    // Given
    const root = await temporaryEvidence("hostile-escape")

    try {
      // When
      const result = await runEscapingScenario(root, {
        delayMs: 250,
        observationMs: 300,
        timeoutMs: 50,
      })

      // Then
      expect(result).toMatchObject({
        cleanup: { processTree: "complete", residue: [], sandbox: "complete" },
        owner: "E-STATE",
        scenarioId: "G04",
        sentinelExists: false,
        status: "FAIL",
      })
      expect(result.process.exitCode).toBeNull()
      expect(result.process.timedOut).toBeTrue()
      expect(result.process.processGroupOwned).toBe(process.platform !== "win32")
      expect(result.rawEvidenceBytes).toBeGreaterThan(0)
      const rawBytes = await Promise.all([
        readFile(resolve(root, result.process.stdout.path)),
        readFile(resolve(root, result.process.stderr.path)),
      ])
      expect(rawBytes.reduce((total, bytes) => total + bytes.byteLength, 0)).toBeGreaterThan(0)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 10_000)

  test("Given later harness failures When preserving diagnostics Then the first named failure remains unchanged", async () => {
    // Given
    const root = await temporaryEvidence("hostile-first-failure")

    try {
      // When
      await preserveFirstFailure(root, {
        scenarioId: "G07" satisfies ScenarioId,
        stage: "scenario",
      })
      await preserveFirstFailure(root, { scenarioId: "G24" satisfies ScenarioId, stage: "cleanup" })

      // Then
      expect(JSON.parse(await readFile(join(root, "first-failure.json"), "utf8"))).toMatchObject({
        scenarioId: "G07",
        stage: "scenario",
      })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("Given the overall cap expires When replay continues Then every scenario is named FAIL and none counts PASS", async () => {
    // Given
    const root = await temporaryEvidence("hostile-overall-timeout")

    try {
      // When
      const verdict = await replayHostile({ overallTimeoutMs: 1, root })

      // Then
      expect(verdict.status).toBe("FAIL")
      expect(verdict.results.map((result) => result.scenarioId).join(",")).toBe(
        HOSTILE_SCENARIO_IDS.join(","),
      )
      expect(verdict.results.every((result) => result.status === "FAIL")).toBeTrue()
      expect(verdict.results.every((result) => result.rawEvidenceBytes > 0)).toBeTrue()
      expect(verdict.results.some((result) => result.process.timedOut)).toBeTrue()
      expect(await readFile(join(root, "first-failure.json"), "utf8")).toContain(
        '"scenarioId": "G01"',
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 10_000)
})
