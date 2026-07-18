import { link, mkdir, open, rename, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import type { StatePathGuard } from "./paths"
import type { Deadline } from "./repo-lock"

export type AtomicOptions = {
  readonly deadline: Deadline
  readonly guard?: StatePathGuard
  readonly beforePublish?: () => void
}

export class AtomicFileError extends Error {
  readonly name = "AtomicFileError"
  constructor(readonly code: "deadline_expired") {
    super(code)
  }
}

function assertDeadline(deadline: Deadline): void {
  if (!deadline.isValid()) throw new AtomicFileError("deadline_expired")
}

function isRetryable(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EPERM" || error.code === "EBUSY" || error.code === "EACCES")
  )
}

async function preparedTemp(path: string, bytes: string, options: AtomicOptions): Promise<string> {
  assertDeadline(options.deadline)
  await options.guard?.(path)
  await mkdir(dirname(path), { recursive: true })
  await options.guard?.(path)
  const temp = join(dirname(path), `.${basename(path)}.tmp-${crypto.randomUUID()}`)
  const file = await open(temp, "wx")
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally {
    await file.close()
  }
  return temp
}

export async function atomicReplace(
  path: string,
  bytes: string,
  options: AtomicOptions,
): Promise<void> {
  const temp = await preparedTemp(path, bytes, options)
  try {
    options.beforePublish?.()
    await options.guard?.(path)
    while (true) {
      assertDeadline(options.deadline)
      try {
        await rename(temp, path)
        return
      } catch (error) {
        if (!isRetryable(error)) throw error
        await Bun.sleep(Math.min(5, options.deadline.remainingMs()))
      }
    }
  } finally {
    await rm(temp, { force: true })
  }
}

export async function atomicCreate(
  path: string,
  bytes: string,
  options: AtomicOptions,
): Promise<void> {
  const temp = await preparedTemp(path, bytes, options)
  try {
    options.beforePublish?.()
    await options.guard?.(path)
    assertDeadline(options.deadline)
    await link(temp, path)
  } finally {
    await rm(temp, { force: true })
  }
}
