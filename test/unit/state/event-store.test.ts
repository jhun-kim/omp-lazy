import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { EventStore } from "../../../src/state/event-store"
import { statePaths } from "../../../src/state/paths"
import { deadlineAfter } from "../../../src/state/repo-lock"
import { createEvent, startRun, temporaryRoot } from "../../fixtures/store-fixtures"

describe("immutable event store", () => {
  test("Given sequential events When appended Then strict sequence discovery returns them", async () => {
    // Given
    const root = await temporaryRoot("events-happy")
    const store = new EventStore(statePaths(root).root)
    const event = createEvent(startRun(root))

    // When
    await store.append(event, deadlineAfter(1_000))

    // Then
    expect(await store.readAll()).toEqual([event])
  })

  test("Given a malformed committed event When read Then corruption is surfaced", async () => {
    // Given
    const root = await temporaryRoot("events-malformed")
    const paths = statePaths(root)
    await mkdir(paths.events, { recursive: true })
    await writeFile(
      join(paths.events, "0000000000000001-55555555-5555-4555-8555-555555555555.json"),
      "{",
    )
    const store = new EventStore(paths.root)

    // When / Then
    await expect(store.readAll()).rejects.toThrow("malformed_event")
  })
})
