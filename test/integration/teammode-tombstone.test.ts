import { afterEach, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  acceptTeamResults,
  bindTeam,
  removeTeamRuntime,
  teamDefinition,
  teamRuntime,
} from "../fixtures/teammode-fixtures"

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe("teammode tombstones", () => {
  test("Given an archived team When deleted Then an atomic tombstone reads as absent", async () => {
    // Given: an accepted, completed, and archived team.
    const runtime = await teamRuntime("tombstone")
    cleanups.push(() => removeTeamRuntime(runtime))
    await runtime.contract.initialize(runtime.caller, teamDefinition)
    await bindTeam(runtime)
    await acceptTeamResults(runtime)
    await runtime.contract.complete(runtime.caller, teamDefinition.teamName)
    await runtime.contract.archive(runtime.caller, teamDefinition.teamName)
    const path = join(runtime.store.paths.root, "teams", `${teamDefinition.teamName}.json`)

    // When: the team is logically deleted.
    const result = await runtime.contract.delete(runtime.caller, teamDefinition.teamName)

    // Then: the file remains as a tombstone while public reads return absent.
    expect(result).toEqual({ ok: true, status: "deleted" })
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      deleted: true,
      schemaVersion: 1,
      teamName: teamDefinition.teamName,
    })
    expect(await runtime.contract.read(teamDefinition.teamName)).toBeNull()
  })
})
