import { rm } from "node:fs/promises"

const RETRYABLE_REMOVE_CODES = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"])
const MAX_REMOVE_RETRIES = 10
const REMOVE_RETRY_DELAY_MS = 100

export async function removeTestTree(path: string): Promise<void> {
  for (let retry = 0; ; retry += 1) {
    try {
      await rm(path, { force: true, recursive: true })
      return
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined
      if (
        typeof code !== "string" ||
        !RETRYABLE_REMOVE_CODES.has(code) ||
        retry === MAX_REMOVE_RETRIES
      ) {
        throw error
      }
      await Bun.sleep(REMOVE_RETRY_DELAY_MS * (retry + 1))
    }
  }
}
