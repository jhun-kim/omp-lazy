import { describe, expect, test } from "bun:test"
import { resolveActiveRun, validateActiveIndex } from "../../../src/state/active-index"
import { activeIndex, startWorkRun } from "../../fixtures/state-fixtures"

describe("active index", () => {
  test("Given one exact owner claim When resolved Then the target run is returned", () => {
    // Given
    const index = activeIndex()
    const run = startWorkRun()

    // When
    const result = resolveActiveRun(index, {
      runs: [run],
      workflow: "start_work",
      sessionId: "session-a",
    })

    // Then
    expect(result).toEqual({ ok: true, run })
  })

  test("Given a foreign exact owner When resolved Then no run is selected", () => {
    // Given
    const index = activeIndex()

    // When
    const result = resolveActiveRun(index, {
      runs: [startWorkRun()],
      workflow: "start_work",
      sessionId: "session-b",
    })

    // Then
    expect(result).toEqual({ ok: false, code: "foreign_owner" })
  })

  test("Given an index target is missing When resolved Then it reports missing_target", () => {
    // Given / When
    const result = resolveActiveRun(activeIndex(), {
      runs: [],
      workflow: "start_work",
      sessionId: "session-a",
    })

    // Then
    expect(result).toEqual({ ok: false, code: "missing_target" })
  })

  test("Given entry and envelope revisions disagree When resolved Then it reports revision_mismatch", () => {
    // Given
    const run = startWorkRun()
    const staleRun = { ...run, revision: run.revision + 1 }

    // When
    const result = resolveActiveRun(activeIndex(), {
      runs: [staleRun],
      workflow: "start_work",
      sessionId: "session-a",
    })

    // Then
    expect(result).toEqual({ ok: false, code: "revision_mismatch" })
  })

  test("Given duplicate live run claims When validated Then it reports duplicate_run", () => {
    // Given
    const index = activeIndex()
    const first = index.entries[0]
    if (first === undefined) throw new Error("fixture entry missing")
    const duplicate = {
      ...index,
      entries: [...index.entries, { ...first, workflow: "ulw_loop" as const }],
    }

    // When
    const result = validateActiveIndex(duplicate)

    // Then
    expect(result).toEqual({ ok: false, code: "duplicate_run" })
  })

  test("Given status hint disagrees with the target run When resolved Then state conflict is reported", () => {
    // Given
    const index = activeIndex()
    const entry = index.entries[0]
    if (entry === undefined) throw new Error("fixture entry missing")
    const staleHint = { ...index, entries: [{ ...entry, statusHint: "paused" as const }] }

    // When
    const result = resolveActiveRun(staleHint, {
      runs: [startWorkRun()],
      workflow: "start_work",
      sessionId: "session-a",
    })

    // Then
    expect(result).toEqual({ ok: false, code: "state_conflict" })
  })
})
