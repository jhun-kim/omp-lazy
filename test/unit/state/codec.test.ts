import { describe, expect, test } from "bun:test"
import { decodeActiveIndex, decodeRun, decodeStateEvent } from "../../../src/state/codec"
import { ROOT, validStartWorkJson, validUlwLoopJson } from "../../fixtures/state-fixtures"

describe("strict state codec", () => {
  test("Given valid start-work bytes When decoded Then the typed envelope is returned", () => {
    // Given / When
    const result = decodeRun(validStartWorkJson(), ROOT)

    // Then
    expect(result.ok).toBeTrue()
  })

  test.each([
    ["malformed JSON", "{"],
    ["unknown workflow", validStartWorkJson({ workflow: "foreign" })],
    ["negative revision", validStartWorkJson({ revision: -1 })],
    ["nonfinite revision", validStartWorkJson({ revision: Number.POSITIVE_INFINITY })],
    ["blank owner", validStartWorkJson({ owner: { sessionId: "", epoch: 1 } })],
    ["unknown property", validStartWorkJson({ surprise: true })],
  ])("Given %s When decoded Then strict parsing rejects it", (_name, bytes) => {
    // Given / When
    const result = decodeRun(bytes, ROOT)

    // Then
    expect(result.ok).toBeFalse()
  })

  test("Given a plan outside the authoritative root When decoded Then it is rejected", () => {
    // Given
    const bytes = validStartWorkJson({
      payload: {
        kind: "start_work",
        status: "active",
        plan: {
          planId: "22222222-2222-4222-8222-222222222222",
          canonicalPath: "c:/other/work.md",
          displayPath: "C:\\other\\work.md",
          allowedRoot: "c:/other",
          allowedRootDisplay: "C:\\other",
          taskFingerprint: "a".repeat(64),
          taskIds: ["task"],
        },
      },
    })

    // When
    const result = decodeRun(bytes, ROOT)

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: "path_mismatch" } })
  })

  test("Given persisted path comparison uses foreign casing When decoded Then root identity rejects it", () => {
    // Given
    const base = JSON.parse(validStartWorkJson())
    base.payload.plan.allowedRoot = "C:/REPO"
    base.payload.plan.canonicalPath = "C:/REPO/.omo/plans/work.md"

    // When
    const result = decodeRun(JSON.stringify(base), ROOT)

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: "path_mismatch" } })
  })

  test("Given duplicate static task ids When decoded Then task identity is rejected", () => {
    // Given
    const base = JSON.parse(validStartWorkJson())
    base.payload.plan.taskIds = ["same", "same"]

    // When
    const result = decodeRun(JSON.stringify(base), ROOT)

    // Then
    expect(result.ok).toBeFalse()
  })

  test("Given duplicate goal and criterion ids When decoded Then referential integrity rejects them", () => {
    // Given
    const base = JSON.parse(validUlwLoopJson())
    const goal = base.payload.goals[0]
    base.payload.goals = [goal, goal]

    // When
    const result = decodeRun(JSON.stringify(base), ROOT)

    // Then
    expect(result.ok).toBeFalse()
  })

  test("Given an activeGoalId without exactly one in-progress goal When decoded Then it is rejected", () => {
    // Given
    const base = JSON.parse(validUlwLoopJson())
    base.payload.goals[0].status = "pending"

    // When
    const result = decodeRun(JSON.stringify(base), ROOT)

    // Then
    expect(result.ok).toBeFalse()
  })

  test("Given criterion ids repeat across goals When decoded Then global identity rejects them", () => {
    // Given
    const base = JSON.parse(validUlwLoopJson())
    const second = structuredClone(base.payload.goals[0])
    second.id = "goal-2"
    second.status = "pending"
    base.payload.goals.push(second)

    // When
    const result = decodeRun(JSON.stringify(base), ROOT)

    // Then
    expect(result.ok).toBeFalse()
  })

  test("Given duplicate active claims When the index is decoded Then ambiguity is preserved as an error", () => {
    // Given
    const entry = {
      workflow: "start_work",
      sessionId: "session-a",
      runId: "11111111-1111-4111-8111-111111111111",
      ownerEpoch: 1,
      runRevision: 2,
      transactionRevision: 4,
      statusHint: "active",
    }

    // When
    const result = decodeActiveIndex(
      JSON.stringify({ schemaVersion: 1, revision: 4, entries: [entry, entry] }),
    )

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: "duplicate_active_key" } })
  })

  test("Given an event kind disagrees with its mutation When decoded Then it is rejected", () => {
    // Given
    const bytes = JSON.stringify({
      schemaVersion: 1,
      eventId: "44444444-4444-4444-8444-444444444444",
      sequence: 5,
      runId: "11111111-1111-4111-8111-111111111111",
      workflow: "start_work",
      kind: "continuation_stuck",
      expected: {
        indexRevision: 4,
        runRevision: 2,
        ownerSessionId: "session-a",
        ownerEpoch: 1,
      },
      mutation: { kind: "continuation_attempted", leafId: "leaf-1", progressRevision: 1 },
      at: "2026-07-13T00:02:00.000Z",
    })

    // When
    const result = decodeStateEvent(bytes)

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: "malformed_event" } })
  })

  test("Given strict migrated v2 envelopes When decoded Then state readers preserve the v2 event envelope", () => {
    // Given
    const run = JSON.parse(validStartWorkJson())
    run.schemaVersion = 2
    run.packetHash = null
    run.expectedHead = null
    const index = {
      schemaVersion: 2,
      migrationRevision: 1,
      revision: 0,
      entries: [],
    }
    const event = {
      schemaVersion: 2,
      eventId: "44444444-4444-4444-8444-444444444444",
      sequence: 1,
      runId: run.runId,
      workflow: "start_work",
      kind: "workflow_controlled",
      expected: {
        indexRevision: 0,
        runRevision: 2,
        ownerSessionId: "session-a",
        ownerEpoch: 1,
        expectedHead: null,
        taskGeneration: null,
      },
      mutation: { kind: "workflow_controlled", control: "pause" },
      legacyHeadUnbound: true,
      at: "2026-07-13T00:02:00.000Z",
    }

    // When
    const decodedRun = decodeRun(JSON.stringify(run), ROOT)
    const decodedIndex = decodeActiveIndex(JSON.stringify(index))
    const decodedEvent = decodeStateEvent(JSON.stringify(event))

    // Then
    expect(decodedRun).toMatchObject({ ok: true, value: { schemaVersion: 1 } })
    expect(decodedIndex).toMatchObject({ ok: true, value: { schemaVersion: 1 } })
    expect(decodedEvent).toMatchObject({ ok: true, value: { schemaVersion: 2 } })
  })

  test("Given a v2 event envelope When decoded Then its exact v2 schema and concurrency fields are preserved", () => {
    // Given
    const event = {
      schemaVersion: 2,
      eventId: "44444444-4444-4444-8444-444444444444",
      sequence: 2,
      runId: "11111111-1111-4111-8111-111111111111",
      workflow: "start_work",
      kind: "workflow_controlled",
      expected: {
        indexRevision: 1,
        runRevision: 1,
        ownerSessionId: "session-a",
        ownerEpoch: 2,
        expectedHead: null,
        taskGeneration: null,
      },
      mutation: { kind: "workflow_controlled", control: "pause" },
      legacyHeadUnbound: true,
      at: "2026-07-13T00:02:00.000Z",
    }

    // When
    const result = decodeStateEvent(JSON.stringify(event))

    // Then
    expect(result).toMatchObject({
      ok: true,
      value: { schemaVersion: 2, expected: { ownerEpoch: 2, taskGeneration: null } },
    })
  })

  test("Given a v2 event omits its required head constraint When decoded Then strict parsing rejects it", () => {
    // Given
    const event = {
      schemaVersion: 2,
      eventId: "44444444-4444-4444-8444-444444444444",
      sequence: 2,
      runId: "11111111-1111-4111-8111-111111111111",
      workflow: "start_work",
      kind: "workflow_controlled",
      expected: {
        indexRevision: 1,
        runRevision: 1,
        ownerSessionId: "session-a",
        ownerEpoch: 2,
        taskGeneration: null,
      },
      mutation: { kind: "workflow_controlled", control: "pause" },
      legacyHeadUnbound: true,
      at: "2026-07-13T00:02:00.000Z",
    }

    // When
    const result = decodeStateEvent(JSON.stringify(event))

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: "malformed_event" } })
  })
})
