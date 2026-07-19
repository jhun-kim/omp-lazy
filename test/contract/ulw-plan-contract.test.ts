import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

const root = join(import.meta.dir, "..", "..")
const skillRoot = join(root, "skills", "ulw-plan(omp)")

async function read(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), "utf8")
}

describe("ulw-plan skill contract", () => {
  it("ships the exact progressive-disclosure surface and namespaced agents", async () => {
    // Given: the Todo14 package paths required by the reviewed plan.
    const paths = [
      "skills/ulw-plan(omp)/SKILL.md",
      "skills/ulw-plan(omp)/references/intent-clear.md",
      "skills/ulw-plan(omp)/references/intent-unclear.md",
      "skills/ulw-plan(omp)/references/full-workflow.md",
      "skills/ulw-plan(omp)/scripts/scaffold-plan.mjs",
      "agents/omp-lazy-planner.md",
      "agents/omp-lazy-metis.md",
      "agents/omp-lazy-momus.md",
    ] as const

    // When: every planned asset is loaded from the package source.
    const contents = await Promise.all(paths.map((path) => read(path)))

    // Then: all assets are present and package-namespaced agent identities are distinct.
    expect(contents.every((content) => content.length > 0)).toBe(true)
    expect(contents.slice(5).map((content) => content.match(/^name: (.+)$/m)?.[1])).toEqual([
      "omp-lazy-planner",
      "omp-lazy-metis",
      "omp-lazy-momus",
    ])
  })

  it("uses concise skill metadata and one-level references", async () => {
    // Given: the primary skill entrypoint.
    const skill = await readFile(join(skillRoot, "SKILL.md"), "utf8")

    // When: its YAML metadata and direct Markdown links are inspected.
    const frontmatter = skill.split("---")[1]?.trim().split(/\r?\n/) ?? []
    const links = [...skill.matchAll(/\]\((references\/[a-z-]+\.md)\)/g)].map((match) => match[1])

    // Then: only name/description trigger metadata exists and all three references are direct.
    expect(frontmatter.map((line) => line.split(":", 1)[0])).toEqual(["name", "description"])
    expect(links.sort()).toEqual([
      "references/full-workflow.md",
      "references/intent-clear.md",
      "references/intent-unclear.md",
    ])
  })

  it("routes CLEAR UNCLEAR and explicit interviews without leaving planning mode", async () => {
    // Given: the primary skill and both routing references.
    const [skill, clear, unclear] = await Promise.all([
      read("skills/ulw-plan(omp)/SKILL.md"),
      read("skills/ulw-plan(omp)/references/intent-clear.md"),
      read("skills/ulw-plan(omp)/references/intent-unclear.md"),
    ])
    const combined = `${skill}\n${clear}\n${unclear}`

    // When: routing and sticky-mode requirements are inspected.
    const requiredRules = [
      "Intent: CLEAR",
      "Intent: UNCLEAR",
      "explicit interview",
      "sticky",
      "never implement",
      "owner decision",
    ] as const

    // Then: each route is explicit and accidental implementation fails closed.
    for (const rule of requiredRules) expect(combined.toLowerCase()).toContain(rule.toLowerCase())
  })

  it("requires durable approval before plan creation and resumes after compaction", async () => {
    // Given: the shared workflow mechanics.
    const workflow = await read("skills/ulw-plan(omp)/references/full-workflow.md")

    // When: durable gate and resume requirements are inspected.
    const requirements = [
      "status: awaiting-approval",
      "explicit-user-approval",
      "--draft",
      "--plan",
      "resume",
      "compaction",
      "approval is not execution",
    ] as const

    // Then: approval is persisted and cannot authorize implementation.
    const normalized = workflow.toLowerCase().replaceAll(/\s+/g, " ")
    for (const requirement of requirements) {
      expect(normalized).toContain(requirement.toLowerCase())
    }
  })

  it("defines a decision-complete append-only plan with TLDR filled last", async () => {
    // Given: the shared workflow mechanics.
    const workflow = await read("skills/ulw-plan(omp)/references/full-workflow.md")

    // When: plan-writing invariants are inspected.
    const requirements = [
      "decision-complete",
      "append-only",
      "## TL;DR (For humans)",
      "Fill the TL;DR last",
      "## Final verification wave",
      "happy",
      "failure",
    ] as const

    // Then: downstream execution requires no hidden interview or human QA.
    for (const requirement of requirements)
      expect(workflow.toLowerCase()).toContain(requirement.toLowerCase())
  })

  it("requires two fresh independent review identities and rejects reviewer reuse", async () => {
    // Given: the shared review workflow and both review agents.
    const [workflow, metis, momus] = await Promise.all([
      read("skills/ulw-plan(omp)/references/full-workflow.md"),
      read("agents/omp-lazy-metis.md"),
      read("agents/omp-lazy-momus.md"),
    ])

    // When: review identity and result rules are inspected.
    const combined = `${workflow}\n${metis}\n${momus}`

    // Then: both identities must independently approve and one identity cannot fill both lanes.
    expect(combined).toContain("omp-lazy-metis")
    expect(combined).toContain("omp-lazy-momus")
    expect(combined.toLowerCase()).toContain("distinct actual agent ids")
    expect(combined.toLowerCase()).toContain("same-reviewer reuse")
    expect(combined).toContain("APPROVE")
  })

  it("removes Codex-only runtime and Goal mutation claims", async () => {
    // Given: every shipped Todo14 planning document and agent definition.
    const paths = [
      "skills/ulw-plan(omp)/SKILL.md",
      "skills/ulw-plan(omp)/references/intent-clear.md",
      "skills/ulw-plan(omp)/references/intent-unclear.md",
      "skills/ulw-plan(omp)/references/full-workflow.md",
      "agents/omp-lazy-planner.md",
      "agents/omp-lazy-metis.md",
      "agents/omp-lazy-momus.md",
    ] as const
    const combined = (await Promise.all(paths.map((path) => read(path)))).join("\n")

    // When: forbidden host-specific assumptions are scanned.
    const forbidden = [
      "CODEX_HOME",
      "multi_agent_v1",
      "multi_agent_v2",
      "gpt-",
      "agent_type",
      "create_goal",
      "update_goal",
      "role TOML",
    ] as const

    // Then: the workflow remains OMP-native and Goal-independent.
    for (const token of forbidden) expect(combined).not.toContain(token)
    expect(combined).toContain("Do not activate, create, or mutate native Goal state")
  })
})
