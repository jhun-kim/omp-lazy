import { readFile } from "node:fs/promises"
import { atomicReplace } from "../state/atomic-file"
import type { StatePathGuard } from "../state/paths"
import type { Deadline } from "../state/repo-lock"

const MAX_WAL_BYTES = 4 * 1_024 * 1_024
const MAX_WAL_ENTRIES = 1_000

export class WorkerAcceptanceWalError extends Error {
  readonly name = "WorkerAcceptanceWalError"

  constructor(readonly code: "deadline_expired" | "wal_too_large" | "malformed_wal") {
    super(code)
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

export async function readAcceptanceWal(
  path: string,
  guard?: StatePathGuard,
): Promise<readonly unknown[]> {
  let bytes: string
  await guard?.(path)
  try {
    bytes = await readFile(path, "utf8")
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  if (Buffer.byteLength(bytes) > MAX_WAL_BYTES) throw new WorkerAcceptanceWalError("wal_too_large")
  const lines = bytes.split("\n").filter((line) => line.length > 0)
  if (lines.length > MAX_WAL_ENTRIES) throw new WorkerAcceptanceWalError("wal_too_large")
  try {
    return lines.map((line) => JSON.parse(line))
  } catch (error) {
    if (error instanceof SyntaxError) throw new WorkerAcceptanceWalError("malformed_wal")
    throw error
  }
}

export async function appendAcceptanceWal(
  path: string,
  value: unknown,
  options: {
    readonly beforePublish?: () => void
    readonly deadline: Deadline
    readonly guard?: StatePathGuard
  },
): Promise<void> {
  if (!options.deadline.isValid()) throw new WorkerAcceptanceWalError("deadline_expired")
  const entries = [...(await readAcceptanceWal(path, options.guard)), value]
  if (entries.length > MAX_WAL_ENTRIES) throw new WorkerAcceptanceWalError("wal_too_large")
  const lines = entries.map((entry) => JSON.stringify(entry))
  if (lines.some((line) => line === undefined)) {
    throw new WorkerAcceptanceWalError("malformed_wal")
  }
  const bytes = `${lines.join("\n")}\n`
  if (Buffer.byteLength(bytes) > MAX_WAL_BYTES) throw new WorkerAcceptanceWalError("wal_too_large")
  await atomicReplace(path, bytes, {
    deadline: options.deadline,
    ...(options.beforePublish === undefined ? {} : { beforePublish: options.beforePublish }),
    ...(options.guard === undefined ? {} : { guard: options.guard }),
  })
}
