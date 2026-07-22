import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { decodeStateEvent } from "../../../src/state/codec"
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

  test("Given a v2 event When read Then every concurrency and audit field survives", async () => {
    // Given
    const root = await temporaryRoot("events-v2-envelope")
    const paths = statePaths(root)
    const decoded = decodeStateEvent(
      JSON.stringify({
        schemaVersion: 2,
        eventId: "55555555-5555-4555-8555-555555555555",
        sequence: 1,
        runId: "11111111-1111-4111-8111-111111111111",
        workflow: "start_work",
        kind: "workflow_controlled",
        expected: {
          indexRevision: 0,
          runRevision: 1,
          ownerSessionId: "session-a",
          ownerEpoch: 1,
          expectedHead: null,
          taskGeneration: null,
        },
        mutation: { kind: "workflow_controlled", control: "pause" },
        legacyHeadUnbound: true,
        at: "2026-07-13T00:02:00.000Z",
      }),
    )
    if (!decoded.ok) throw decoded.error
    const event = decoded.value
    await mkdir(paths.events, { recursive: true })
    await writeFile(
      join(paths.events, "0000000000000001-55555555-5555-4555-8555-555555555555.json"),
      JSON.stringify(event),
    )

    // When
    const events = await new EventStore(paths.root).readAll()

    // Then
    expect(events).toEqual([event])
  })
})
