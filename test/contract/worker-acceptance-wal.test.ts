import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendAcceptanceWal } from "../../src/contracts/worker-acceptance-wal"
import { deadlineAfter } from "../../src/state/repo-lock"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

describe("worker acceptance WAL", () => {
  it("preserves the complete prior file when atomic publication fails", async () => {
    // Given: one completely published WAL event.
    const root = await mkdtemp(join(tmpdir(), "omp-lazy-wal-atomic-"))
    roots.push(root)
    const path = join(root, "acceptance.wal.jsonl")
    const options = { deadline: deadlineAfter(2_000) }
    await appendAcceptanceWal(path, { sequence: 1 }, options)
    const before = await readFile(path, "utf8")

    // When: publication of the next whole-file replacement fails before rename.
    const attempted = appendAcceptanceWal(
      path,
      { sequence: 2 },
      {
        ...options,
        beforePublish: () => {
          throw new Error("injected publish failure")
        },
      },
    )

    // Then: no partial appended bytes are visible.
    await expect(attempted).rejects.toThrow("injected publish failure")
    expect(await readFile(path, "utf8")).toBe(before)
  })
})
