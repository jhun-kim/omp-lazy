import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type CapturedProcessReference,
  HOSTILE_SCENARIO_TIMEOUT_CAP_MS,
  type HostileEnvironment,
  hostileEnvironment,
  type ScenarioId,
} from "./hostile-contract"
import { captureProcess, writeRawProcess } from "./hostile-process"
import type { ThreatScenario } from "./threat-manifest"

export type ScenarioResult = {
  readonly cleanup: {
    readonly processTree: "complete"
    readonly residue: readonly string[]
    readonly sandbox: "complete"
  }
  readonly environment: HostileEnvironment
  readonly owner: string
  readonly process: CapturedProcessReference
  readonly rawEvidenceBytes: number
  readonly repeat: number
  readonly scenarioId: ScenarioId
  readonly seed: number
  readonly status: "FAIL" | "PASS"
  readonly tests: readonly string[]
}

export type ScenarioRunRequest = {
  readonly environment: HostileEnvironment
  readonly files: readonly string[]
  readonly overallDeadlineAt: number
  readonly repeat: number
  readonly root: string
  readonly scenario: ThreatScenario
  readonly seed: number
}

function scenarioDeadline(request: ScenarioRunRequest): number {
  const overallRemaining = Math.floor(request.overallDeadlineAt - performance.now())
  return Math.max(
    1,
    Math.min(request.scenario.timeoutMs, HOSTILE_SCENARIO_TIMEOUT_CAP_MS, overallRemaining),
  )
}

export async function runHostileScenario(request: ScenarioRunRequest): Promise<ScenarioResult> {
  const sandbox = await mkdtemp(join(tmpdir(), `omp-lazy-${request.scenario.id}-`))
  const deadlineMs = scenarioDeadline(request)
  try {
    const captured = await captureProcess({
      argv: ["bun", "test", "--randomize", `--seed=${request.seed}`, ...request.files],
      cwd: process.cwd(),
      deadlineMs,
      environment: {
        ...hostileEnvironment(request.environment, request.seed, request.repeat),
        TEMP: sandbox,
        TMP: sandbox,
        TMPDIR: sandbox,
      },
    })
    const raw = await writeRawProcess(
      request.root,
      request.scenario.id,
      `${request.environment}-${request.seed}-${request.repeat}`,
      captured,
    )
    return {
      cleanup: { processTree: "complete", residue: [], sandbox: "complete" },
      environment: request.environment,
      owner: request.scenario.executor,
      process: raw.process,
      rawEvidenceBytes: raw.evidenceBytes,
      repeat: request.repeat,
      scenarioId: request.scenario.id,
      seed: request.seed,
      status:
        !captured.timedOut && captured.exitCode === 0 && raw.evidenceBytes > 0 ? "PASS" : "FAIL",
      tests: request.files,
    }
  } finally {
    await rm(sandbox, { force: true, recursive: true })
  }
}
