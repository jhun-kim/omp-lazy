import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  assertExactProductDiscovery,
  inspectProductDiscovery,
} from "../../scripts/product-discovery-contract"
import { expectedProductRuntime } from "../../scripts/product-runtime-contract"
import { completeDiscoveryCandidate } from "../fixtures/discovery-contract-fixtures"
import { repositoryRoot, run } from "../fixtures/package-test-helpers"

const sandboxes: string[] = []

afterEach(async () =>
  Promise.all(sandboxes.splice(0).map((path) => rm(path, { force: true, recursive: true }))),
)

describe("public discovery probe", () => {
  it("verifies the product discovery contract in no-arg product mode", async () => {
    // Given: the repository root is the product package root.
    const root = repositoryRoot

    // When: the discovery smoke probe runs with no explicit fixture arguments.
    const result = run(["bun", "scripts/probe-discovery.ts"], root)

    // Then: it succeeds only after comparing plugin-owned discovery to the product contract.
    expect(result.exitCode).toBe(0)
    const receipt = JSON.parse(result.stdout)
    expect(receipt.mode).toBe("product")
    expect(receipt.productSkillNames).toEqual(expectedProductRuntime.skillNames)
    expect(receipt.productAgentNames).toEqual(expectedProductRuntime.agentNames)
    expect(receipt.warnings).toEqual([])
  }, 30_000)

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

  it("discovers the repository product surface with exact OMO skill and agent inventory", async () => {
    // Given: the repository root is configured as an OMP extension package.
    const root = repositoryRoot

    // When: discovery runs through OMP public skill and task-agent APIs.
    const receipt = await assertExactProductDiscovery(root)

    // Then: discovery owns exactly the approved product skill and agent names.
    expect(receipt.productSkillNames).toEqual(expectedProductRuntime.skillNames)
    expect(receipt.productAgentNames).toEqual(expectedProductRuntime.agentNames)
  })

  it("discovers the completed product inventory without unexpected names", async () => {
    // Given: T08 restores the four product agent assets after T07 restored OMO skills.
    const root = repositoryRoot

    // When: the current repository is discovered through the public APIs.
    const receipt = await inspectProductDiscovery(root)

    // Then: every expected skill and agent is present with no unexpected product-owned names.
    expect(receipt.missingSkillNames).toEqual([])
    expect(receipt.missingAgentNames).toEqual([])
    expect(receipt.unexpectedSkillNames).toEqual([])
    expect(receipt.unexpectedAgentNames).toEqual([])
    expect(receipt.productSkillNames).toEqual(expectedProductRuntime.skillNames)
    expect(receipt.productAgentNames).toEqual(expectedProductRuntime.agentNames)
  })

  it("checks an installed copy candidate through the same discovery contract", async () => {
    // Given: a copied package surface represents an installed candidate directory.
    const candidate = await completeDiscoveryCandidate("installed-copy", sandboxes)

    // When: the copied candidate is discovered through public OMP APIs.
    const receipt = await assertExactProductDiscovery(candidate)

    // Then: installed/copy discovery uses the same single expected inventory source.
    expect(receipt.productSkillNames).toEqual(expectedProductRuntime.skillNames)
    expect(receipt.productAgentNames).toEqual(expectedProductRuntime.agentNames)
  })
})
