import { join } from "node:path"
import type { Process } from "@oh-my-pi/pi-natives"

const KILL_ATTEMPT_MS = 1_000
export const POST_KILL_COMPLETION_MS = 1_000

export class ProcessTreeCleanupError extends Error {
  override readonly name = "ProcessTreeCleanupError"
  constructor(readonly pid: number) {
    super(`process tree cleanup failed: ${pid}`)
  }
}

export type Settlement<T> =
  | { readonly settled: true; readonly value: T }
  | { readonly settled: false }

export async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<Settlement<T>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve({ settled: false }), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve({ settled: true, value })
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

async function taskkill(command: string, pid: number): Promise<boolean> {
  let killer: Bun.Subprocess<"ignore", "ignore", "ignore">
  try {
    killer = Bun.spawn([command, "/PID", String(pid), "/T", "/F"], {
      stdin: "ignore",
      stderr: "ignore",
      stdout: "ignore",
    })
  } catch (error) {
    if (error instanceof Error) return false
    throw error
  }
  const result = await settleWithin(killer.exited, KILL_ATTEMPT_MS)
  if (result.settled) return result.value === 0
  killer.kill()
  await settleWithin(killer.exited, KILL_ATTEMPT_MS)
  return false
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
    throw error
  }
}

async function awaitGroupExit(pid: number): Promise<boolean> {
  const deadline = performance.now() + KILL_ATTEMPT_MS
  while (performance.now() < deadline) {
    if (!groupExists(pid)) return true
    await Bun.sleep(10)
  }
  return !groupExists(pid)
}

export async function cleanupProcessTree(request: {
  readonly completionSettled: () => boolean
  readonly pid: number
  readonly systemRoot: string
  readonly windowsProcesses?: readonly Process[]
}): Promise<void> {
  if (process.platform === "win32") {
    const trackedTreeWasRunning = request.windowsProcesses?.some(
      (trackedProcess) => trackedProcess.status() === "running",
    )
    for (const trackedProcess of request.windowsProcesses ?? []) trackedProcess.killTree()
    if (trackedTreeWasRunning === true) return
    if (await taskkill("taskkill", request.pid)) return
    if (
      request.systemRoot.length > 0 &&
      (await taskkill(join(request.systemRoot, "System32", "taskkill.exe"), request.pid))
    ) {
      return
    }
    throw new ProcessTreeCleanupError(request.pid)
  }
  if (!groupExists(request.pid)) {
    if (request.completionSettled()) return
    throw new ProcessTreeCleanupError(request.pid)
  }
  process.kill(-request.pid, "SIGKILL")
  if (!(await awaitGroupExit(request.pid))) throw new ProcessTreeCleanupError(request.pid)
}
