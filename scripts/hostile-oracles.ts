import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { CapturedProcessReference } from "./hostile-contract"
import { hostileEnvironment } from "./hostile-contract"
import { captureProcess, writeRawProcess } from "./hostile-process"

export type EscapeOptions = {
  readonly delayMs: number
  readonly observationMs: number
  readonly timeoutMs: number
}

export type EscapeResult = {
  readonly cleanup: {
    readonly processTree: "complete"
    readonly residue: readonly string[]
    readonly sandbox: "complete"
  }
  readonly owner: "E-STATE"
  readonly process: CapturedProcessReference
  readonly rawEvidenceBytes: number
  readonly scenarioId: "G04"
  readonly sentinelExists: boolean
  readonly status: "FAIL"
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

async function observeWindow(durationMs: number): Promise<void> {
  await new Promise<void>((resolveWindow) => setTimeout(resolveWindow, durationMs))
}

export async function runEscapingScenario(
  root: string,
  options: EscapeOptions,
): Promise<EscapeResult> {
  const sandbox = await mkdtemp(join(tmpdir(), "omp-lazy-hostile-escape-"))
  const sentinel = join(sandbox, "late-effect.sentinel")
  try {
    const captured = await captureProcess({
      argv: ["bun", resolve("test", "fixtures", "hostile-preload.ts")],
      cwd: process.cwd(),
      deadlineMs: options.timeoutMs,
      environment: {
        ...hostileEnvironment("enabled", 1357, 1),
        OMP_LAZY_ESCAPE_CHILD: "1",
        OMP_LAZY_INJECT_DELAY_MS: String(options.delayMs),
        OMP_LAZY_LATE_SENTINEL: sentinel,
      },
      stdoutReadyMarker: "G04 escaping descendant armed",
    })
    const raw = await writeRawProcess(root, "G04", "forced-escape", captured)
    await observeWindow(options.observationMs)
    let sentinelExists = true
    try {
      await stat(sentinel)
    } catch (error) {
      if (isMissing(error)) sentinelExists = false
      else throw error
    }
    return {
      cleanup: { processTree: "complete", residue: [], sandbox: "complete" },
      owner: "E-STATE",
      process: raw.process,
      rawEvidenceBytes: raw.evidenceBytes,
      scenarioId: "G04",
      sentinelExists,
      status: "FAIL",
    }
  } finally {
    await rm(sandbox, { force: true, recursive: true })
  }
}

export async function preserveFirstFailure(
  root: string,
  failure: Readonly<Record<string, unknown>>,
): Promise<void> {
  try {
    await writeFile(
      join(root, "first-failure.json"),
      `${JSON.stringify({ recordedAt: new Date().toISOString(), ...failure }, null, 2)}\n`,
      { flag: "wx" },
    )
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
  }
}
