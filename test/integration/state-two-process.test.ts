import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { EventStore } from "../../src/state/event-store"
import { statePaths } from "../../src/state/paths"
import { initializedStore, pauseEvent, temporaryRoot } from "../fixtures/store-fixtures"

describe("two-process state CAS", () => {
  test("Given two processes claim revision one When released together Then one commits and one conflicts", async () => {
    // Given
    const root = await temporaryRoot("two-process")
    const { run } = await initializedStore(root)
    const firstOutput = join(root.displayPath, "first.json")
    const secondOutput = join(root.displayPath, "second.json")
    const writer = join(process.cwd(), "test", "fixtures", "state-writer.ts")
    const first = Bun.spawn(
      ["bun", writer, root.displayPath, JSON.stringify(pauseEvent(run)), firstOutput],
      { stdout: "ignore", stderr: "pipe" },
    )
    const second = Bun.spawn(
      [
        "bun",
        writer,
        root.displayPath,
        JSON.stringify(pauseEvent(run, "77777777-7777-4777-8777-777777777777")),
        secondOutput,
      ],
      { stdout: "ignore", stderr: "pipe" },
    )

    // When
    const exits = await Promise.all([first.exited, second.exited])
    const results = [
      JSON.parse(await readFile(firstOutput, "utf8")),
      JSON.parse(await readFile(secondOutput, "utf8")),
    ]

    // Then
    expect(exits).toEqual([0, 0])
    expect(results.filter((result) => result.ok === true)).toHaveLength(1)
    expect(results.filter((result) => result.code === "index_revision_conflict")).toHaveLength(1)
    expect(await new EventStore(statePaths(root).root).readAll()).toHaveLength(2)
  })
})
