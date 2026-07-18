import { afterEach, describe, expect, it } from "bun:test"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  assertExactProductDiscovery,
  inspectProductDiscovery,
} from "../../scripts/product-discovery-contract"
import { expectedProductRuntime } from "../../scripts/product-runtime-contract"
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
    const candidate = await completeDiscoveryCandidate("installed-copy")

    // When: the copied candidate is discovered through public OMP APIs.
    const receipt = await assertExactProductDiscovery(candidate)

    // Then: installed/copy discovery uses the same single expected inventory source.
    expect(receipt.productSkillNames).toEqual(expectedProductRuntime.skillNames)
    expect(receipt.productAgentNames).toEqual(expectedProductRuntime.agentNames)
  })

  it("rejects duplicate discovered skill and agent names", async () => {
    // Given: a candidate contains extra files claiming existing product identities.
    const candidate = await completeDiscoveryCandidate("duplicate")
    await mkdir(join(candidate, "skills", "duplicate-skill"), { recursive: true })
    await writeFile(
      join(candidate, "skills", "duplicate-skill", "SKILL.md"),
      skillMarkdown(expectedProductRuntime.skillNames[0] ?? "", "duplicate skill"),
    )
    await writeFile(
      join(candidate, "agents", "duplicate-agent.md"),
      agentMarkdown(expectedProductRuntime.agentNames[0] ?? "", "duplicate agent"),
    )

    // When/Then: the file-surface contract rejects duplicates before discovery can shadow them.
    await expect(assertExactProductDiscovery(candidate)).rejects.toThrow(
      "duplicate discovery names",
    )
  })

  it("rejects a copied product candidate with a duplicate skill through the probe", async () => {
    // Given: a copied candidate contains an extra skill file claiming an approved product name.
    const candidate = await completeDiscoveryCandidate("probe-duplicate-skill")
    await mkdir(join(candidate, "skills", "duplicate-skill"), { recursive: true })
    await writeFile(
      join(candidate, "skills", "duplicate-skill", "SKILL.md"),
      skillMarkdown(expectedProductRuntime.skillNames[0] ?? "", "duplicate skill"),
    )

    // When: the discovery product gate runs with an explicit copied candidate path.
    const result = run(["bun", "scripts/probe-discovery.ts", "--cwd", candidate], repositoryRoot)

    // Then: the duplicate skill delta is precise and fails the process.
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("duplicate discovery names: skill:")
  }, 30_000)

  it("rejects the exact unexpected agent in a copied plugin", async () => {
    // Given: a candidate contains all product inventory plus one unapproved agent file.
    const candidate = await completeDiscoveryCandidate("unexpected-agent")
    await writeFile(
      join(candidate, "agents", "unexpected-agent.md"),
      agentMarkdown("unexpected-agent", "unexpected agent"),
    )

    // When/Then: exact discovery rejects the copied plugin by the unexpected item name.
    await expect(assertExactProductDiscovery(candidate)).rejects.toThrow(
      "unexpected agent discovery: unexpected-agent",
    )
  })

  it("rejects malformed skill and agent frontmatter", async () => {
    // Given: a candidate has machine-consumed metadata with wrong structural types.
    const candidate = await completeDiscoveryCandidate("malformed-frontmatter")
    await writeFile(
      join(candidate, "skills", expectedProductRuntime.skillNames[0] ?? "", "SKILL.md"),
      "---\nname: 7\ndescription: false\n---\n\n# Bad skill\n",
    )

    // When/Then: skill frontmatter is parsed structurally, not by prose snapshots.
    await expect(assertExactProductDiscovery(candidate)).rejects.toThrow(
      "malformed skill frontmatter",
    )

    // Given: the skill is repaired but an agent has malformed machine metadata.
    await writeFile(
      join(candidate, "skills", expectedProductRuntime.skillNames[0] ?? "", "SKILL.md"),
      skillMarkdown(expectedProductRuntime.skillNames[0] ?? "", "repaired skill"),
    )
    await writeFile(
      join(candidate, "agents", `${expectedProductRuntime.agentNames[0] ?? ""}.md`),
      "---\nname: 7\ndescription: false\nblocking: yes\n---\n\nBad agent\n",
    )

    // When/Then: agent frontmatter is also structurally validated.
    await expect(assertExactProductDiscovery(candidate)).rejects.toThrow(
      "malformed agent frontmatter",
    )
  })

  it("rejects missing referenced files and required attribution", async () => {
    // Given: a candidate points at a relative reference that is not present.
    const brokenReference = await completeDiscoveryCandidate("missing-reference")
    await writeFile(
      join(brokenReference, "skills", expectedProductRuntime.skillNames[0] ?? "", "SKILL.md"),
      `${skillMarkdown(expectedProductRuntime.skillNames[0] ?? "", "broken reference")}\n[missing](references/nope.md)\n`,
    )

    // When/Then: relative references must resolve within the package.
    await expect(assertExactProductDiscovery(brokenReference)).rejects.toThrow(
      "missing Markdown reference",
    )

    // Given: ulw-research omits its mandatory attribution file.
    const missingAttribution = await completeDiscoveryCandidate("missing-attribution")
    await rm(join(missingAttribution, "skills", "ulw-research", "ATTRIBUTION.md"))

    // When/Then: attribution is a structural package requirement.
    await expect(assertExactProductDiscovery(missingAttribution)).rejects.toThrow(
      "missing skill attribution ulw-research",
    )
  })

  it("rejects unowned discovery results for approved names", async () => {
    // Given: the candidate is missing one approved skill and a foreign project claims that name.
    const candidate = await completeDiscoveryCandidate("unowned")
    const stolenSkillName = expectedProductRuntime.skillNames[0]
    if (stolenSkillName === undefined) throw new Error("expected skill inventory is empty")
    await rm(join(candidate, "skills", stolenSkillName), { force: true, recursive: true })
    const foreignProject = await mkdtemp(join(repositoryRoot, ".todo3-unowned-project-"))
    sandboxes.push(foreignProject)
    const foreignExtension = join(foreignProject, "foreign-extension")
    await mkdir(join(foreignExtension, "skills", stolenSkillName), { recursive: true })
    await mkdir(join(foreignProject, ".omp"), { recursive: true })
    await writeFile(
      join(foreignProject, ".omp", "settings.json"),
      `${JSON.stringify({ extensions: [foreignExtension, candidate] })}\n`,
    )
    await writeFile(
      join(foreignExtension, "skills", stolenSkillName, "SKILL.md"),
      skillMarkdown(stolenSkillName, "foreign skill"),
    )

    // When: public discovery sees the approved name from outside the candidate root.
    const receipt = await inspectProductDiscovery(candidate, foreignProject)

    // Then: the name is not accepted as product-owned inventory.
    await expect(assertExactProductDiscovery(candidate, foreignProject)).rejects.toThrow(
      `unowned skill discovery: ${stolenSkillName}`,
    )
    expect(receipt.missingSkillNames).toContain(stolenSkillName)
    expect(receipt.unownedSkillNames).toContain(stolenSkillName)
    expect(receipt.productSkillNames).not.toContain(stolenSkillName)
  })
})

async function completeDiscoveryCandidate(prefix: string): Promise<string> {
  const candidate = await mkdtemp(join(repositoryRoot, `.todo3-discovery-${prefix}-`))
  sandboxes.push(candidate)
  await cp(join(repositoryRoot, "package.json"), join(candidate, "package.json"))
  await mkdir(join(candidate, "skills"), { recursive: true })
  await mkdir(join(candidate, "agents"), { recursive: true })
  await Promise.all([
    ...expectedProductRuntime.skillNames.map((name) => writeSkill(candidate, name)),
    ...expectedProductRuntime.agentNames.map((name) => writeAgent(candidate, name)),
  ])
  return candidate
}

async function writeSkill(root: string, name: string): Promise<void> {
  const skillRoot = join(root, "skills", name)
  await mkdir(skillRoot, { recursive: true })
  await writeFile(join(skillRoot, "SKILL.md"), skillMarkdown(name, `${name} contract fixture`))
  if (name === "ulw-loop") {
    await mkdir(join(skillRoot, "references"), { recursive: true })
    await writeFile(join(skillRoot, "references", "full-workflow.md"), "# Full workflow\n")
  }
  if (name === "ulw-research") {
    await writeFile(join(skillRoot, "ATTRIBUTION.md"), "# Attribution\n")
  }
}

async function writeAgent(root: string, name: string): Promise<void> {
  await writeFile(
    join(root, "agents", `${name}.md`),
    agentMarkdown(name, `${name} contract fixture`),
  )
}

function skillMarkdown(name: string, description: string): string {
  const body =
    name === "ulw-loop" ? "Use the [full workflow](references/full-workflow.md)." : "Run."
  const attribution = name === "ulw-research" ? "\nSee [attribution](ATTRIBUTION.md)." : ""
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}${attribution}\n`
}

function agentMarkdown(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\nblocking: false\n---\n\nReturn the declared fixture result.\n`
}
