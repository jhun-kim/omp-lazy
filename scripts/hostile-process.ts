import { mkdir, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import type { CapturedProcess, CapturedProcessReference, RawReference } from "./hostile-contract"

export type CaptureRequest = {
  readonly argv: readonly [string, ...string[]]
  readonly cwd: string
  readonly deadlineMs: number
  readonly environment: Readonly<Record<string, string | undefined>>
}

export class ProcessTreeCleanupError extends Error {
  override readonly name = "ProcessTreeCleanupError"
  constructor(readonly pid: number) {
    super(`process tree cleanup failed: ${pid}`)
  }
}

async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    const killer = Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], {
      stderr: "ignore",
      stdout: "ignore",
    })
    if ((await killer.exited) !== 0) throw new ProcessTreeCleanupError(pid)
    return
  }
  try {
    process.kill(-pid, "SIGKILL")
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
    try {
      process.kill(pid, "SIGKILL")
    } catch (fallbackError) {
      if (
        !(
          fallbackError instanceof Error &&
          "code" in fallbackError &&
          fallbackError.code === "ESRCH"
        )
      ) {
        throw fallbackError
      }
    }
  }
}

export async function captureProcess(request: CaptureRequest): Promise<CapturedProcess> {
  const startedAt = new Date()
  const started = performance.now()
  const child = Bun.spawn([...request.argv], {
    cwd: request.cwd,
    env: request.environment,
    stderr: "pipe",
    stdout: "pipe",
  })
  const completion = Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
  ])
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timedOut = await Promise.race([
    completion.then(() => false),
    new Promise<true>((resolveTimeout) => {
      timeoutHandle = setTimeout(() => resolveTimeout(true), request.deadlineMs)
    }),
  ])
  if (timedOut) await killProcessTree(child.pid)
  const [exitCode, stdout, stderr] = await completion
  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  return {
    argv: request.argv,
    cwd: request.cwd,
    deadlineMs: request.deadlineMs,
    durationMs: Math.round(performance.now() - started),
    endedAt: new Date().toISOString(),
    exitCode: timedOut ? null : exitCode,
    startedAt: startedAt.toISOString(),
    stderr: new Uint8Array(stderr),
    stdout: new Uint8Array(stdout),
    timedOut,
  }
}

function digest(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
}

function reference(root: string, path: string, bytes: Uint8Array): RawReference {
  return { path: relative(root, path).replaceAll("\\", "/"), sha256: digest(bytes) }
}

export async function writeRawProcess(
  root: string,
  directory: string,
  prefix: string,
  captured: CapturedProcess,
): Promise<{ readonly evidenceBytes: number; readonly process: CapturedProcessReference }> {
  const rawRoot = join(root, "raw", directory)
  await mkdir(rawRoot, { recursive: true })
  const stdoutPath = join(rawRoot, `${prefix}.stdout.bin`)
  const stderrPath = join(rawRoot, `${prefix}.stderr.bin`)
  await Promise.all([
    writeFile(stdoutPath, captured.stdout),
    writeFile(stderrPath, captured.stderr),
  ])
  return {
    evidenceBytes: captured.stdout.byteLength + captured.stderr.byteLength,
    process: {
      argv: captured.argv,
      cwd: captured.cwd,
      deadlineMs: captured.deadlineMs,
      durationMs: captured.durationMs,
      endedAt: captured.endedAt,
      exitCode: captured.exitCode,
      startedAt: captured.startedAt,
      stderr: reference(root, stderrPath, captured.stderr),
      stdout: reference(root, stdoutPath, captured.stdout),
      timedOut: captured.timedOut,
    },
  }
}
