import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { repositoryRoot, run } from "../fixtures/package-test-helpers"

const sandboxes: string[] = []

afterEach(async () =>
  Promise.all(sandboxes.splice(0).map((path) => rm(path, { force: true, recursive: true }))),
)

describe("public discovery probe", () => {
  it("discovers extension skills and task agents through separate public APIs", async () => {
    // Given: a project configured with a conventional fixture package.
    const sandbox = await mkdtemp(join(repositoryRoot, ".todo3-discovery-"))
    sandboxes.push(sandbox)
    const home = join(sandbox, "home")
    const projectConfig = join(sandbox, ".omp")
    const fixture = join(repositoryRoot, "test", "fixtures", "discovery-package")
    await mkdir(home, { recursive: true })
    await mkdir(projectConfig, { recursive: true })
    await writeFile(
      join(projectConfig, "settings.json"),
      `${JSON.stringify({ extensions: [fixture] })}\n`,
    )

    // When: discovery runs with isolated home variables.
    const result = run(["bun", "scripts/probe-discovery.ts", "--cwd", sandbox], repositoryRoot, {
      HOME: home,
      USERPROFILE: home,
    })

    // Then: both independent discovery surfaces find their package assets.
    expect(result.exitCode).toBe(0)
    const receipt = JSON.parse(result.stdout)
    expect(receipt.skillNames).toContain("fixture-skill")
    expect(receipt.agentNames).toContain("fixture-agent")
  }, 30_000)
})
