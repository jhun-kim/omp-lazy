import { mkdir, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import type { CapturedProcess, CapturedProcessReference, RawReference } from "./hostile-contract"
import {
  cleanupProcessTree,
  POST_KILL_COMPLETION_MS,
  ProcessTreeCleanupError,
  settleWithin,
} from "./process-tree-cleanup"

const STARTUP_SIGNAL_TIMEOUT_MS = 10_000

export type CaptureRequest = {
  readonly argv: readonly [string, ...string[]]
  readonly cwd: string
  readonly deadlineMs: number
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly stdoutReadyMarker?: string
  readonly stdoutReadyTimeoutMs?: number
}

export class ProcessReadinessError extends Error {
  override readonly name = "ProcessReadinessError"
  constructor(
    readonly pid: number,
    readonly reason: "exited" | "timeout",
  ) {
    super(`process readiness ${reason}: ${pid}`)
  }
}

type ProcessCompletion = readonly [number, Uint8Array, Uint8Array]

function captureStdout(
  stream: ReadableStream<Uint8Array>,
  readyMarker: string | undefined,
): { readonly bytes: Promise<Uint8Array>; readonly ready: Promise<void> } {
  let signalReady: (() => void) | undefined
  const ready =
    readyMarker === undefined
      ? Promise.resolve()
      : new Promise<void>((resolveReady) => {
          signalReady = resolveReady
        })
  const bytes = (async () => {
    const chunks: Uint8Array[] = []
    const decoder = readyMarker === undefined ? undefined : new TextDecoder()
    const reader = stream.getReader()
    let byteLength = 0
    let searchable = ""
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      chunks.push(chunk.value)
      byteLength += chunk.value.byteLength
      if (decoder !== undefined && readyMarker !== undefined && signalReady !== undefined) {
        searchable += decoder.decode(chunk.value, { stream: true })
        if (searchable.includes(readyMarker)) {
          signalReady()
          signalReady = undefined
        } else if (searchable.length >= readyMarker.length) {
          searchable = searchable.slice(1 - readyMarker.length)
        }
      }
    }
    const output = new Uint8Array(byteLength)
    let offset = 0
    for (const chunk of chunks) {
      output.set(chunk, offset)
      offset += chunk.byteLength
    }
    return output
  })()
  return { bytes, ready }
}

async function terminateAndComplete(request: {
  readonly completion: Promise<ProcessCompletion>
  readonly completionSettled: () => boolean
  readonly pid: number
  readonly systemRoot: string
}): Promise<ProcessCompletion> {
  const cleanup = await cleanupProcessTree({
    completionSettled: request.completionSettled,
    pid: request.pid,
    systemRoot: request.systemRoot,
  }).then(
    () => ({ ok: true }) as const,
    (error: unknown) => ({ error, ok: false }) as const,
  )
  const completed = await settleWithin(request.completion, POST_KILL_COMPLETION_MS)
  if (!completed.settled) {
    if (!cleanup.ok) throw cleanup.error
    throw new ProcessTreeCleanupError(request.pid)
  }
  if (!cleanup.ok) throw cleanup.error
  return completed.value
}

export async function captureProcess(request: CaptureRequest): Promise<CapturedProcess> {
  const startedAt = new Date()
  const started = performance.now()
  const child = Bun.spawn([...request.argv], {
    cwd: request.cwd,
    detached: process.platform !== "win32",
    env: request.environment,
    stderr: "pipe",
    stdout: "pipe",
  })
  const stdoutCapture = captureStdout(child.stdout, request.stdoutReadyMarker)
  let completionSettled = false
  const completion = Promise.all([
    child.exited,
    stdoutCapture.bytes,
    new Response(child.stderr).bytes(),
  ]).then((result) => {
    completionSettled = true
    return result
  })
  const systemRoot =
    Object.entries(process.env).find(([name]) => name.toLowerCase() === "systemroot")?.[1] ?? ""
  if (request.stdoutReadyMarker !== undefined) {
    const startup = await settleWithin(
      Promise.race([
        stdoutCapture.ready.then(() => "ready" as const),
        completion.then(() => "exited" as const),
      ]),
      request.stdoutReadyTimeoutMs ?? STARTUP_SIGNAL_TIMEOUT_MS,
    )
    if (!startup.settled) {
      await terminateAndComplete({
        completion,
        completionSettled: () => completionSettled,
        pid: child.pid,
        systemRoot,
      })
      throw new ProcessReadinessError(child.pid, "timeout")
    }
    if (startup.value === "exited") throw new ProcessReadinessError(child.pid, "exited")
  }
  const initial = await settleWithin(completion, request.deadlineMs)
  const timedOut = !initial.settled
  const completed = initial.settled
    ? initial.value
    : await terminateAndComplete({
        completion,
        completionSettled: () => completionSettled,
        pid: child.pid,
        systemRoot,
      })
  if (!timedOut && process.platform !== "win32") {
    await cleanupProcessTree({ completionSettled: () => true, pid: child.pid, systemRoot })
  }
  const [exitCode, stdout, stderr] = completed
  return {
    argv: request.argv,
    cwd: request.cwd,
    deadlineMs: request.deadlineMs,
    durationMs: Math.round(performance.now() - started),
    endedAt: new Date().toISOString(),
    exitCode: timedOut ? null : exitCode,
    processGroupOwned: process.platform !== "win32",
    startedAt: startedAt.toISOString(),
    stderr,
    stdout,
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
      processGroupOwned: captured.processGroupOwned,
      startedAt: captured.startedAt,
      stderr: reference(root, stderrPath, captured.stderr),
      stdout: reference(root, stdoutPath, captured.stdout),
      timedOut: captured.timedOut,
    },
  }
}
