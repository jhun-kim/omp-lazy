import { mkdir, readdir, stat, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"

export const HOSTILE_SEEDS = [1357, 7331, 424242] as const
export const HOSTILE_REPEATS = 3 as const
export const HOSTILE_ENVIRONMENTS = ["enabled", "disabled", "unlinked"] as const
export const LATE_EFFECT_WAIT_MS = 31_000 as const
export const LATE_EFFECT_HOST_TIMEOUT_MS = 30_000 as const

type HostileEnvironment = (typeof HOSTILE_ENVIRONMENTS)[number]
type ProcessReceipt = {
  readonly argv: readonly string[]
  readonly durationMs: number
  readonly environment: HostileEnvironment
  readonly exitCode: number
  readonly repeat: number
  readonly seed: number
  readonly stderrPath: string
  readonly stdoutPath: string
  readonly timedOut: boolean
}

function environmentFor(
  mode: HostileEnvironment,
  seed: number,
  repeat: number,
): Readonly<Record<string, string>> {
  return {
    ...process.env,
    OMP_LAZY_HOSTILE_MODE: mode,
    OMP_LAZY_HOSTILE_SEED: String(seed),
    OMP_LAZY_HOSTILE_REPEAT: String(repeat),
    OMP_LAZY_EXTENSION_ENABLED: mode === "enabled" ? "1" : "0",
    OMP_LAZY_EXTENSION_LINKED: mode === "unlinked" ? "0" : "1",
    OMP_LAZY_INJECT_DELAY_MS: String((seed + repeat) % 17),
    OMP_LAZY_CRASH_POINT: "none",
  }
}

async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited
    return
  }
  process.kill(-pid, "SIGKILL")
}

async function testFiles(): Promise<readonly string[]> {
  const roots = ["test/contract", "test/integration", "test/unit"] as const
  const files: string[] = []
  for (const root of roots) {
    try {
      for (const entry of await readdir(root, { recursive: true })) {
        if (entry.endsWith(".test.ts")) files.push(join(root, entry))
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
  }
  return files.sort()
}

async function runOne(
  root: string,
  mode: HostileEnvironment,
  seed: number,
  repeat: number,
  files: readonly string[],
): Promise<ProcessReceipt> {
  const argv = ["bun", "test", "--randomize", `--seed=${seed}`, ...files]
  const startedAt = performance.now()
  let timedOut = false
  const child = Bun.spawn(argv, {
    env: environmentFor(mode, seed, repeat),
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => {
    timedOut = true
    void killTree(child.pid)
  }, 120_000)
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
  ])
  clearTimeout(timeout)
  if (timedOut) await killTree(child.pid)
  const prefix = `${mode}-seed-${seed}-repeat-${repeat}`
  const stdoutPath = join(root, `${prefix}.stdout.bin`)
  const stderrPath = join(root, `${prefix}.stderr.bin`)
  await Promise.all([
    writeFile(stdoutPath, new Uint8Array(stdout)),
    writeFile(stderrPath, new Uint8Array(stderr)),
  ])
  return {
    argv,
    durationMs: Math.round(performance.now() - startedAt),
    environment: mode,
    exitCode,
    repeat,
    seed,
    stderrPath: relative(root, stderrPath),
    stdoutPath: relative(root, stdoutPath),
    timedOut,
  }
}

async function runLateEffectOracle(root: string): Promise<void> {
  const sentinel = join(root, "late-effect.sentinel")
  const child = Bun.spawn(["bun", "test/fixtures/hostile-preload.ts"], {
    env: {
      ...process.env,
      OMP_LAZY_CRASH_POINT: "none",
      OMP_LAZY_INJECT_DELAY_MS: String(LATE_EFFECT_HOST_TIMEOUT_MS * 2),
      OMP_LAZY_LATE_SENTINEL: sentinel,
    },
    stdout: "ignore",
    stderr: "ignore",
  })
  const timeout = setTimeout(() => void killTree(child.pid), LATE_EFFECT_HOST_TIMEOUT_MS)
  const exitCode = await child.exited
  clearTimeout(timeout)
  await killTree(child.pid)
  await Bun.sleep(LATE_EFFECT_WAIT_MS)
  let sentinelExists = true
  try {
    await stat(sentinel)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") sentinelExists = false
    else throw error
  }
  await writeFile(
    join(root, "late-effect.json"),
    `${JSON.stringify({ exitCode, hostTimeoutMs: LATE_EFFECT_HOST_TIMEOUT_MS, sentinelExists, waitAfterTimeoutMs: LATE_EFFECT_WAIT_MS }, null, 2)}\n`,
  )
  if (sentinelExists) throw new TypeError("late effect occurred after host timeout")
}

export async function replayHostile(): Promise<void> {
  const runId = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${process.pid}`
  const root = resolve(".omo", "evidence", "replay", runId)
  await mkdir(root, { recursive: true })
  const files = await testFiles()
  if (files.length === 0) throw new TypeError("hostile replay collected zero tests")
  const receipts: ProcessReceipt[] = []
  await runLateEffectOracle(root)
  for (const mode of HOSTILE_ENVIRONMENTS) {
    for (const seed of HOSTILE_SEEDS) {
      for (let repeat = 1; repeat <= HOSTILE_REPEATS; repeat += 1) {
        const receipt = await runOne(root, mode, seed, repeat, files)
        receipts.push(receipt)
        await writeFile(
          join(root, "receipts.json"),
          `${JSON.stringify({ runId, receipts }, null, 2)}\n`,
        )
        if (receipt.timedOut || receipt.exitCode !== 0)
          throw new TypeError(`hostile replay failed: ${mode}/${seed}/${repeat}`)
      }
    }
  }
}

if (import.meta.main) {
  // no-excuse-ok: catch -- CLI boundary preserves the first failure as a nonzero result.
  try {
    await replayHostile()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
