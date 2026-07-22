import { afterEach, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { TaskEventLedger } from "../../src/gates/task-event-ledger"
import { removeTestTree } from "../fixtures/remove-test-tree"
import { initializedStore, temporaryRoot } from "../fixtures/store-fixtures"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTestTree))
})

test("Given concurrent fan-out calls When real processes reserve Then durable CAS permits one", async () => {
  for (let replay = 0; replay < 3; replay += 1) {
    // Given
    const root = await temporaryRoot(`task-reservation-${replay}`)
    roots.push(root.displayPath)
    const { store } = await initializedStore(root)
    const writer = join(process.cwd(), "test", "fixtures", "task-reservation-writer.ts")
    const outputs = [join(root.displayPath, "first.json"), join(root.displayPath, "second.json")]
    const children = outputs.map((output, index) =>
      Bun.spawn(["bun", writer, root.displayPath, `tool-${index}`, output], {
        stdout: "ignore",
        stderr: "pipe",
      }),
    )

    // When
    const exits = await Promise.all(children.map((child) => child.exited))
    const results = await Promise.all(
      outputs.map(async (output) => JSON.parse(await readFile(output, "utf8"))),
    )
    const reservations = await new TaskEventLedger(store).reservations("session-a")

    // Then
    expect(exits).toEqual([0, 0])
    expect(results.filter((result) => result.allowed === true)).toHaveLength(1)
    expect(
      results.filter((result) => result.result?.reason === "omp-lazy: fan-out limit exceeded"),
    ).toHaveLength(1)
    expect(reservations).toHaveLength(1)
    expect(reservations.reduce((total, reservation) => total + reservation.itemCount, 0)).toBe(2)
  }
})
