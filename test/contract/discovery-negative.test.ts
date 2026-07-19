import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  assertExactProductDiscovery,
  inspectProductDiscovery,
} from "../../scripts/product-discovery-contract"
import { expectedProductRuntime } from "../../scripts/product-runtime-contract"
import {
  agentMarkdown,
  completeDiscoveryCandidate,
  skillMarkdown,
} from "../fixtures/discovery-contract-fixtures"
import { repositoryRoot, run } from "../fixtures/package-test-helpers"

const sandboxes: string[] = []

afterEach(async () =>
  Promise.all(sandboxes.splice(0).map((path) => rm(path, { force: true, recursive: true }))),
)

describe("public discovery negative contract", () => {
  it("rejects duplicate discovered skill and agent names", async () => {
    // Given: a candidate contains extra files claiming existing product identities.
    const candidate = await completeDiscoveryCandidate("duplicate", sandboxes)
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
    const candidate = await completeDiscoveryCandidate("probe-duplicate-skill", sandboxes)
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
    const candidate = await completeDiscoveryCandidate("unexpected-agent", sandboxes)
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
    const candidate = await completeDiscoveryCandidate("malformed-frontmatter", sandboxes)
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
    const brokenReference = await completeDiscoveryCandidate("missing-reference", sandboxes)
    await writeFile(
      join(brokenReference, "skills", expectedProductRuntime.skillNames[0] ?? "", "SKILL.md"),
      `${skillMarkdown(expectedProductRuntime.skillNames[0] ?? "", "broken reference")}\n[missing](references/nope.md)\n`,
    )

    // When/Then: relative references must resolve within the package.
    await expect(assertExactProductDiscovery(brokenReference)).rejects.toThrow(
      "missing Markdown reference",
    )

    // Given: ulw-research(omp) omits its mandatory attribution file.
    const missingAttribution = await completeDiscoveryCandidate("missing-attribution", sandboxes)
    await rm(join(missingAttribution, "skills", "ulw-research(omp)", "ATTRIBUTION.md"))

    // When/Then: attribution is a structural package requirement.
    await expect(assertExactProductDiscovery(missingAttribution)).rejects.toThrow(
      "missing skill attribution ulw-research(omp)",
    )
  })

  it("rejects unowned discovery results for approved names", async () => {
    // Given: the candidate is missing one approved skill and a foreign project claims that name.
    const candidate = await completeDiscoveryCandidate("unowned", sandboxes)
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
