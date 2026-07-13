import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { atomicCreate, atomicReplace } from "../../../src/state/atomic-file"
import { deadlineAfter } from "../../../src/state/repo-lock"
import { temporaryRoot } from "../../fixtures/store-fixtures"

describe("atomic files", () => {
  test("Given absent and existing targets When created/replaced Then complete bytes are published", async () => {
    // Given
    const root = await temporaryRoot("atomic-happy")
    const path = join(root.displayPath, "state.json")

    // When
    await atomicCreate(path, "first", { deadline: deadlineAfter(1_000) })
    await atomicReplace(path, "second", { deadline: deadlineAfter(1_000) })

    // Then
    expect(await readFile(path, "utf8")).toBe("second")
    expect((await readdir(root.displayPath)).filter((name) => name.includes(".tmp-"))).toEqual([])
  })

  test("Given a fault before publication When replacing Then original bytes survive and temp is cleaned", async () => {
    // Given
    const root = await temporaryRoot("atomic-fault")
    const path = join(root.displayPath, "state.json")
    await atomicCreate(path, "original", { deadline: deadlineAfter(1_000) })

    // When
    const action = atomicReplace(path, "replacement", {
      deadline: deadlineAfter(1_000),
      beforePublish: () => {
        throw new Error("injected")
      },
    })

    // Then
    await expect(action).rejects.toThrow("injected")
    expect(await readFile(path, "utf8")).toBe("original")
    expect((await readdir(root.displayPath)).filter((name) => name.includes(".tmp-"))).toEqual([])
  })
})
