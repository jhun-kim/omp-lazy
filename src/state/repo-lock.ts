import { mkdir, open, readFile, unlink } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"
import type { StatePathGuard } from "./paths"

export interface Deadline {
  remainingMs(): number
  isValid(): boolean
}

export type LockMetadata = {
  readonly nonce: string
  readonly pid: number
  readonly sessionId: string
  readonly purpose: "stop" | "command"
  readonly acquiredAt: string
}

const metadataSchema = z
  .object({
    nonce: z.uuid(),
    pid: z.number().int().positive(),
    sessionId: z.string().trim().min(1),
    purpose: z.enum(["stop", "command"]),
    acquiredAt: z.iso.datetime({ offset: true }),
  })
  .strict()

function isFileError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

export class LockStateError extends Error {
  readonly name = "LockStateError"
  constructor(readonly code: "malformed_lock") {
    super(code)
  }
}

function decodeMetadata(bytes: string): LockMetadata {
  let value: unknown
  try {
    value = JSON.parse(bytes)
  } catch {
    throw new LockStateError("malformed_lock")
  }
  const parsed = metadataSchema.safeParse(value)
  if (!parsed.success) throw new LockStateError("malformed_lock")
  return parsed.data
}

export class LockHandle {
  constructor(
    readonly path: string,
    readonly metadata: LockMetadata,
    readonly guard?: StatePathGuard,
  ) {}

  async release(): Promise<boolean> {
    await this.guard?.(this.path)
    let bytes: string
    try {
      bytes = await readFile(this.path, "utf8")
    } catch (error) {
      if (isFileError(error, "ENOENT")) return false
      throw error
    }
    let current: LockMetadata
    try {
      current = decodeMetadata(bytes)
    } catch (error) {
      if (error instanceof LockStateError) return false
      throw error
    }
    if (current.nonce !== this.metadata.nonce) return false
    await this.guard?.(this.path)
    await unlink(this.path)
    return true
  }
}

export class RepoLock {
  constructor(
    readonly path: string,
    readonly guard?: StatePathGuard,
  ) {}

  async tryAcquire(request: {
    readonly deadline: Deadline
    readonly purpose: "stop" | "command"
    readonly sessionId: string
    readonly maxWaitMs: number
  }): Promise<LockHandle | null> {
    await this.guard?.(this.path)
    await mkdir(dirname(this.path), { recursive: true })
    await this.guard?.(this.path)
    const waitUntil = performance.now() + Math.max(0, request.maxWaitMs)
    while (request.deadline.isValid() && performance.now() <= waitUntil) {
      const metadata: LockMetadata = {
        nonce: crypto.randomUUID(),
        pid: process.pid,
        sessionId: request.sessionId,
        purpose: request.purpose,
        acquiredAt: new Date().toISOString(),
      }
      try {
        await this.guard?.(this.path)
        const file = await open(this.path, "wx")
        try {
          await file.writeFile(JSON.stringify(metadata))
          await file.sync()
        } finally {
          await file.close()
        }
        return new LockHandle(this.path, metadata, this.guard)
      } catch (error) {
        if (!isFileError(error, "EEXIST")) throw error
      }
      const remaining = Math.min(request.deadline.remainingMs(), waitUntil - performance.now())
      if (remaining <= 0) return null
      await Bun.sleep(Math.min(5, remaining))
    }
    return null
  }

  async readMetadata(): Promise<LockMetadata | null> {
    await this.guard?.(this.path)
    let bytes: string
    try {
      bytes = await readFile(this.path, "utf8")
    } catch (error) {
      if (isFileError(error, "ENOENT")) return null
      throw error
    }
    return decodeMetadata(bytes)
  }
}

export function deadlineAfter(durationMs: number): Deadline {
  const expiresAt = performance.now() + Math.max(0, durationMs)
  return {
    remainingMs: () => Math.max(0, expiresAt - performance.now()),
    isValid: () => performance.now() < expiresAt,
  }
}
