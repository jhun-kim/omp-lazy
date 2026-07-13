import { afterEach, describe, expect, test } from "bun:test"
import { rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { validateTeamWorktree } from "../../src/workflows/teammode-worktree"
import {
  acceptTeamResults,
  bindTeam,
  createWorktree,
  observeTeam,
  removeTeamRuntime,
  teamDefinition,
  teamRuntime,
} from "../fixtures/teammode-fixtures"

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe("teammode worktree binding", () => {
  test("accepts a clean related worktree and rejects main, dirty, and unrelated roots", async () => {
    const runtime = await teamRuntime("worktrees")
    const related = createWorktree(runtime.displayPath, "team-related")
    const unrelated = await teamRuntime("unrelated")
    cleanups.push(
      () => removeTeamRuntime(runtime),
      () => removeTeamRuntime(unrelated),
    )
    cleanups.push(() => rm(related, { recursive: true, force: true }))

    expect(await validateTeamWorktree(runtime.displayPath, related)).toMatchObject({ ok: true })
    expect(await validateTeamWorktree(runtime.displayPath, runtime.displayPath)).toEqual({
      ok: false,
      code: "main_worktree",
    })
    await writeFile(join(related, "dirty.txt"), "dirty\n")
    expect(await validateTeamWorktree(runtime.displayPath, related)).toEqual({
      ok: false,
      code: "dirty_worktree",
    })
    expect(await validateTeamWorktree(runtime.displayPath, unrelated.displayPath)).toEqual({
      ok: false,
      code: "unrelated_repo",
    })
  })

  test("binds only actual Todo8 identities and preserves an idempotent roster", async () => {
    const runtime = await teamRuntime("binding")
    cleanups.push(() => removeTeamRuntime(runtime))
    await runtime.contract.initialize(runtime.caller, teamDefinition)

    const bound = await bindTeam(runtime)
    const bytes = JSON.stringify(await runtime.contract.read(teamDefinition.teamName))
    const replay = await runtime.contract.bind(runtime.caller, teamDefinition.teamName)

    expect(bound).toMatchObject({ ok: true, status: "bound" })
    expect(
      bound.ok ? bound.state?.members.map((member) => String(member.actualAgentId)) : [],
    ).toEqual(["actual-implementation", "actual-verification"])
    expect(replay).toMatchObject({ ok: true, status: "replayed" })
    expect(JSON.stringify(await runtime.contract.read(teamDefinition.teamName))).toBe(bytes)
  })

  test("inline task results block activation without inventing a synchronous team", async () => {
    const runtime = await teamRuntime("inline")
    cleanups.push(() => removeTeamRuntime(runtime))
    await runtime.contract.initialize(runtime.caller, teamDefinition)

    expect(await bindTeam(runtime, false)).toEqual({
      ok: false,
      code: "async_capability_unproven",
    })
    expect(
      (await runtime.contract.read(teamDefinition.teamName))?.members.every(
        (member) => member.actualAgentId === null,
      ),
    ).toBe(true)
  })

  test("a dirty worktree cannot mutate the planned roster", async () => {
    const runtime = await teamRuntime("dirty-binding")
    const worktree = createWorktree(runtime.displayPath, "team-dirty-binding")
    cleanups.push(() => removeTeamRuntime(runtime))
    cleanups.push(() => rm(worktree, { recursive: true, force: true }))
    await runtime.contract.initialize(runtime.caller, teamDefinition)
    await observeTeam(runtime)
    await writeFile(join(worktree, "dirty.txt"), "dirty\n")
    const before = JSON.stringify(await runtime.contract.read(teamDefinition.teamName))

    expect(
      await runtime.contract.bind(runtime.caller, teamDefinition.teamName, [
        { requestedName: "implementation", path: worktree },
      ]),
    ).toEqual({ ok: false, code: "dirty_worktree" })
    expect(JSON.stringify(await runtime.contract.read(teamDefinition.teamName))).toBe(before)
  })

  test("archive and delete refuse an active team without parent acceptance", async () => {
    const runtime = await teamRuntime("acceptance")
    cleanups.push(() => removeTeamRuntime(runtime))
    await runtime.contract.initialize(runtime.caller, teamDefinition)
    await bindTeam(runtime)

    expect(await runtime.contract.complete(runtime.caller, teamDefinition.teamName)).toEqual({
      ok: false,
      code: "parent_acceptance_incomplete",
    })
    expect(await runtime.contract.archive(runtime.caller, teamDefinition.teamName)).toEqual({
      ok: false,
      code: "team_not_completed",
    })
    expect(await runtime.contract.delete(runtime.caller, teamDefinition.teamName)).toEqual({
      ok: false,
      code: "team_not_archived",
    })
  })

  test("completion, archive, and deletion require accepted current receipts", async () => {
    const runtime = await teamRuntime("lifecycle")
    cleanups.push(() => removeTeamRuntime(runtime))
    await runtime.contract.initialize(runtime.caller, teamDefinition)
    await bindTeam(runtime)
    await acceptTeamResults(runtime)

    expect(await runtime.contract.complete(runtime.caller, teamDefinition.teamName)).toMatchObject({
      ok: true,
      status: "completed",
    })
    expect(await runtime.contract.archive(runtime.caller, teamDefinition.teamName)).toMatchObject({
      ok: true,
      status: "archived",
      runtimeAgentsArchived: false,
    })
    expect(await runtime.contract.delete(runtime.caller, teamDefinition.teamName)).toEqual({
      ok: true,
      status: "deleted",
    })
    expect(await runtime.contract.read(teamDefinition.teamName)).toBeNull()
  })
})
