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
import { captureProcess, ProcessReadinessError } from "../../scripts/hostile-process"
import { runHostileScenario } from "../../scripts/hostile-scenario"
import { replayHostile } from "../../scripts/replay-hostile"
import { threatManifest } from "../../scripts/threat-manifest"

async function temporaryEvidence(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `omp-lazy-${label}-`))
}

describe("bounded hostile replay", () => {
  test("Given the frozen threat registry When loading scenario ownership Then G01-G29 each has tests and an independent bound", async () => {
    // Given
    const expected = Array.from(
      { length: 29 },
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

  test("Given a delayed stdout readiness marker When capture starts Then its deadline begins after the complete marker", async () => {
    // Given
    const marker = "hostile capture ready"

    // When
    const captured = await captureProcess({
      argv: [
        "bun",
        "-e",
        `process.stdout.write("hostile "); await Bun.sleep(100); process.stdout.write("capture "); await Bun.sleep(10); process.stdout.write("ready\\n"); await Bun.sleep(5_000)`,
      ],
      cwd: process.cwd(),
      deadlineMs: 25,
      environment: process.env,
      stdoutReadyMarker: marker,
    })

    // Then
    expect(captured.timedOut).toBeTrue()
    expect(new TextDecoder().decode(captured.stdout)).toBe(`${marker}\n`)
  }, 10_000)

  test("Given a required stdout marker that never arrives When startup remains alive Then capture fails within the startup bound", async () => {
    // Given
    const capture = captureProcess({
      argv: ["bun", "-e", "await Bun.sleep(1_000)"],
      cwd: process.cwd(),
      deadlineMs: 5_000,
      environment: process.env,
      stdoutReadyMarker: "never emitted",
      stdoutReadyTimeoutMs: 25,
    })

    // When / Then
    await expect(capture).rejects.toMatchObject({
      name: ProcessReadinessError.name,
      reason: "timeout",
    })
  }, 10_000)

  test("Given a readiness leader exits before its marker When a detached writer survives Then failure is bounded and no late sentinel appears", async () => {
    // Given: a leader that spawns an ignored-stdio delayed writer and exits before readiness.
    const root = await temporaryEvidence("readiness-early-exit")
    const sentinel = join(root, "late-sentinel.txt")
    const fixture = resolve("test", "fixtures", "delayed-descendant.ts")
    const started = performance.now()

    try {
      // When: capture observes leader completion before the required marker.
      await expect(
        captureProcess({
          argv: ["bun", fixture, "readiness-parent", sentinel],
          cwd: process.cwd(),
          deadlineMs: 5_000,
          environment: process.env,
          stdoutReadyMarker: "readiness marker never emitted",
          stdoutReadyTimeoutMs: 2_000,
        }),
      ).rejects.toMatchObject({
        name: ProcessReadinessError.name,
        reason: "exited",
      })
      const failureDurationMs = performance.now() - started
      await Bun.sleep(1_150)

      // Then: failure stays bounded and cleanup prevents the delayed write on every host.
      expect(failureDurationMs).toBeLessThan(3_000)
      expect(await Bun.file(sentinel).exists()).toBeFalse()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 10_000)

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
      expect(rawBytes[0]?.toString("utf8")).toContain("G04 escaping descendant armed")
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
