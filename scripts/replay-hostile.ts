import { mkdir, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  type CapturedProcess,
  HOSTILE_ENVIRONMENTS,
  HOSTILE_OVERALL_TIMEOUT_MS,
  HOSTILE_REPEATS,
  HOSTILE_SCENARIO_IDS,
  HOSTILE_SEEDS,
  readHostileScenarioMap,
  type ScenarioId,
} from "./hostile-contract"
import { preserveFirstFailure, runEscapingScenario } from "./hostile-oracles"
import { writeRawProcess } from "./hostile-process"
import { runHostileScenario, type ScenarioResult } from "./hostile-scenario"
import { type ThreatScenario, threatManifest } from "./threat-manifest"

export {
  HOSTILE_ENVIRONMENTS,
  HOSTILE_OVERALL_TIMEOUT_MS,
  HOSTILE_REPEATS,
  HOSTILE_SCENARIO_IDS,
  HOSTILE_SCENARIO_TIMEOUT_CAP_MS,
  HOSTILE_SEEDS,
  readHostileScenarioMap,
} from "./hostile-contract"

export type HostileVerdict = {
  readonly endedAt: string
  readonly overallTimeoutMs: number
  readonly results: readonly ScenarioResult[]
  readonly schemaVersion: 1
  readonly startedAt: string
  readonly status: "FAIL" | "PASS"
}

export type ReplayOptions = {
  readonly overallTimeoutMs?: number
  readonly root?: string
}

function scenarioById(scenarioId: ScenarioId): ThreatScenario {
  const scenario = threatManifest.scenarios.find((candidate) => candidate.id === scenarioId)
  if (scenario === undefined) throw new TypeError(`threat manifest missing ${scenarioId}`)
  return scenario
}

function matrixValue<T>(values: readonly T[], index: number): T {
  const value = values[index % values.length]
  if (value === undefined) throw new TypeError("hostile matrix is empty")
  return value
}

async function overallTimeoutResult(
  root: string,
  scenario: ThreatScenario,
  files: readonly string[],
): Promise<ScenarioResult> {
  const timestamp = new Date().toISOString()
  const stdout = new TextEncoder().encode(`${scenario.id} overall deadline exhausted\n`)
  const stderr = new TextEncoder().encode(`${scenario.id} FAIL before process start\n`)
  const captured: CapturedProcess = {
    argv: ["bun", "test", ...files],
    cwd: process.cwd(),
    deadlineMs: 1,
    durationMs: 0,
    endedAt: timestamp,
    exitCode: null,
    startedAt: timestamp,
    stderr,
    stdout,
    timedOut: true,
  }
  const raw = await writeRawProcess(root, scenario.id, "overall-timeout", captured)
  return {
    cleanup: { processTree: "complete", residue: [], sandbox: "complete" },
    environment: "enabled",
    owner: scenario.executor,
    process: raw.process,
    rawEvidenceBytes: raw.evidenceBytes,
    repeat: 1,
    scenarioId: scenario.id,
    seed: HOSTILE_SEEDS[0],
    status: "FAIL",
    tests: files,
  }
}

export async function replayHostile(options: ReplayOptions = {}): Promise<HostileVerdict> {
  const root = options.root ?? resolve(".omo", "evidence", "plugin-completion-60", "T14")
  const overallTimeoutMs = options.overallTimeoutMs ?? HOSTILE_OVERALL_TIMEOUT_MS
  await rm(root, { force: true, recursive: true })
  await mkdir(root, { recursive: true })
  const startedAt = new Date().toISOString()
  const overallDeadlineAt = performance.now() + overallTimeoutMs
  const map = await readHostileScenarioMap()
  const results: ScenarioResult[] = []

  for (const [index, scenarioId] of HOSTILE_SCENARIO_IDS.entries()) {
    const scenario = scenarioById(scenarioId)
    const files = map[scenarioId]
    const result =
      performance.now() >= overallDeadlineAt
        ? await overallTimeoutResult(root, scenario, files)
        : await runHostileScenario({
            environment: matrixValue(HOSTILE_ENVIRONMENTS, index),
            files,
            overallDeadlineAt,
            repeat: (index % HOSTILE_REPEATS) + 1,
            root,
            scenario,
            seed: matrixValue(HOSTILE_SEEDS, index),
          })
    results.push(result)
    await writeFile(resolve(root, `${scenarioId}.json`), `${JSON.stringify(result, null, 2)}\n`)
    if (result.status === "FAIL") {
      await preserveFirstFailure(root, { result, scenarioId, stage: "scenario" })
    }
  }

  const verdict: HostileVerdict = {
    endedAt: new Date().toISOString(),
    overallTimeoutMs,
    results,
    schemaVersion: 1,
    startedAt,
    status: results.every((result) => result.status === "PASS") ? "PASS" : "FAIL",
  }
  await writeFile(resolve(root, "hostile-verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`)
  return verdict
}

async function main(): Promise<void> {
  try {
    const root = resolve(".omo", "evidence", "plugin-completion-60", "T14")
    if (Bun.argv.slice(2).includes("--force-escape")) {
      await mkdir(root, { recursive: true })
      const result = await runEscapingScenario(root, {
        delayMs: 750,
        observationMs: 1_000,
        timeoutMs: 100,
      })
      await preserveFirstFailure(root, { result, scenarioId: "G04", stage: "forced-escape" })
      await writeFile(resolve(root, "hostile-reject.json"), `${JSON.stringify(result, null, 2)}\n`)
      process.stdout.write(`${JSON.stringify(result)}\n`)
      process.exitCode = 1
      return
    }
    const verdict = await replayHostile({ root })
    process.stdout.write(`${JSON.stringify(verdict)}\n`)
    process.exitCode = verdict.status === "PASS" ? 0 : 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

if (import.meta.main) await main()
