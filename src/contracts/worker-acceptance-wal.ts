import { mkdir, open, readFile } from "node:fs/promises"
import { dirname } from "node:path"
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

export async function readAcceptanceWal(path: string): Promise<readonly unknown[]> {
  let bytes: string
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
  deadline: Deadline,
): Promise<void> {
  if (!deadline.isValid()) throw new WorkerAcceptanceWalError("deadline_expired")
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, "a")
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  if (!deadline.isValid()) throw new WorkerAcceptanceWalError("deadline_expired")
}
