import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadCapability, type Skill } from "@oh-my-pi/pi-coding-agent/discovery"
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery"
import { TeamDefinitionSchema } from "../../src/workflows/teammode-contract"
import { removeTeamRuntime, teamDefinition, teamRuntime } from "../fixtures/teammode-fixtures"

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe("teammode contract", () => {
  const member = (name: string, focus: string, ownership: readonly string[]) => ({
    requestedName: name,
    agentType: "omp-lazy-worker-medium",
    focus,
    ownership,
    deliverable: `${focus} receipt`,
    isolated: true,
  })

  test("requires two unique members with non-overlapping ownership", () => {
    expect(
      TeamDefinitionSchema.safeParse({
        teamName: "api-team",
        members: [member("api", "API", ["src/api"]), member("tests", "tests", ["test/api"])],
      }).success,
    ).toBe(true)
    expect(
      TeamDefinitionSchema.safeParse({ teamName: "solo", members: [member("one", "one", ["src"])] })
        .success,
    ).toBe(false)
    expect(
      TeamDefinitionSchema.safeParse({
        teamName: "overlap",
        members: [member("one", "one", ["src"]), member("two", "two", ["src/api"])],
      }).success,
    ).toBe(false)
  })

  test("Given root ownership When descendants are parsed Then every root form overlaps without rejecting siblings", () => {
    const overlaps = [
      [".", "src"],
      ["./", "src/nested"],
      [".", "docs/deep/file"],
      ["src", "src/api"],
      ["src/api", "src/api"],
    ] as const
    for (const [root, descendant] of overlaps) {
      expect(
        TeamDefinitionSchema.safeParse({
          teamName: "ownership-overlap",
          members: [member("root", "root", [root]), member("nested", "nested", [descendant])],
        }).success,
      ).toBe(false)
    }
    expect(
      TeamDefinitionSchema.safeParse({
        teamName: "ownership-siblings",
        members: [member("api", "api", ["src/api"]), member("ui", "ui", ["src/ui"])],
      }).success,
    ).toBe(true)
  })

  test("initialization is idempotent and missing async surfaces block without state", async () => {
    const runtime = await teamRuntime("contract")
    cleanups.push(() => removeTeamRuntime(runtime))
    const first = await runtime.contract.initialize(runtime.caller, teamDefinition)
    const bytes = JSON.stringify(await runtime.contract.read(teamDefinition.teamName))
    const replay = await runtime.contract.initialize(runtime.caller, teamDefinition)
    const blocked = await runtime.contract.initialize(
      { ...runtime.caller, toolNames: ["task"] },
      { ...teamDefinition, teamName: "blocked-team" },
    )

    expect(first).toMatchObject({ ok: true, status: "created" })
    expect(replay).toMatchObject({ ok: true, status: "replayed" })
    expect(JSON.stringify(await runtime.contract.read(teamDefinition.teamName))).toBe(bytes)
    expect(blocked).toEqual({ ok: false, code: "async_team_surfaces_unavailable" })
    expect(await runtime.contract.read("blocked-team")).toBeNull()
  })

  test("OMP 17.0.5 discovers every namespaced team agent", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "omp-lazy-team-discovery-"))
    const home = join(sandbox, "home")
    await mkdir(join(sandbox, ".omp"), { recursive: true })
    await mkdir(home, { recursive: true })
    await writeFile(
      join(sandbox, ".omp", "settings.json"),
      JSON.stringify({ extensions: [process.cwd()] }),
    )
    cleanups.push(() => rm(sandbox, { recursive: true, force: true }))

    const [{ agents }, skills] = await Promise.all([
      discoverAgents(sandbox, home),
      loadCapability<Skill>("skills", { cwd: sandbox, providers: ["omp-plugins"] }),
    ])
    const expected = [
      "omp-lazy-reviewer",
      "omp-lazy-worker-high",
      "omp-lazy-worker-low",
      "omp-lazy-worker-medium",
    ]
    const discovered = agents.filter((agent) => expected.includes(agent.name))
    expect(discovered.map((agent) => agent.name).sort()).toEqual(expected)
    expect(discovered.every((agent) => agent.blocking === false && agent.model === undefined)).toBe(
      true,
    )
    expect(skills.warnings).toEqual([])
    expect(skills.items.map((skill) => skill.name)).toContain("teammode")
  })
})
