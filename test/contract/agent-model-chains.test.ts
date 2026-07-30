/**
 * Contract test: parsed frontmatter of all 11 agents deep-equals the binding table
 * from the plan (todo 18). This is the single source of truth compared against the files.
 */
import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parseAgentFields } from "@oh-my-pi/pi-coding-agent/discovery/helpers"
import { parseFrontmatter } from "@oh-my-pi/pi-utils"

/**
 * BINDING TABLE - single source of truth for model chains and thinking levels.
 * This is the exact table from the plan's todo 18.
 * omo-native's `artistry` category intentionally has NO counterpart because the roster is frozen.
 */
const AGENT_MODEL_CHAIN_TABLE: Record<
  string,
  { model: string[]; thinkingLevel: string; intent: string }
> = {
  "omp-lazy-worker-low": {
    model: ["@smol", "@task"],
    thinkingLevel: "low",
    intent: "quick / writing",
  },
  "omp-lazy-worker-medium": {
    model: ["@task", "@slow"],
    thinkingLevel: "medium",
    intent: "unspecified-low",
  },
  "omp-lazy-worker-high": {
    model: ["@slow", "@task"],
    thinkingLevel: "high",
    intent: "deep",
  },
  "omp-lazy-explorer": {
    model: ["@smol", "@task"],
    thinkingLevel: "low",
    intent: "explore",
  },
  "omp-lazy-librarian": {
    model: ["@smol", "@task"],
    thinkingLevel: "low",
    intent: "librarian",
  },
  "omp-lazy-researcher": {
    model: ["@task", "@slow"],
    thinkingLevel: "high",
    intent: "unspecified-high research",
  },
  "omp-lazy-planner": {
    model: ["@slow", "@task"],
    thinkingLevel: "high",
    intent: "architect",
  },
  "omp-lazy-metis": {
    model: ["@slow", "@task"],
    thinkingLevel: "high",
    intent: "metis",
  },
  "omp-lazy-momus": {
    model: ["@slow", "@task"],
    thinkingLevel: "max",
    intent: "momus",
  },
  "omp-lazy-qa": {
    model: ["@task", "@smol"],
    thinkingLevel: "medium",
    intent: "visual-engineering / regression QA",
  },
  "omp-lazy-reviewer": {
    model: ["@slow", "@task"],
    thinkingLevel: "high",
    intent: "acceptance review",
  },
}

describe("agent model chains and thinking levels (todo 18)", () => {
  const agentsDir = join(process.cwd(), "agents")

  for (const [agentName, expected] of Object.entries(AGENT_MODEL_CHAIN_TABLE)) {
    test(`${agentName} has model: ${JSON.stringify(expected.model)} and thinkingLevel: ${expected.thinkingLevel}`, async () => {
      const content = await readFile(join(agentsDir, `${agentName}.md`), "utf8")
      const { frontmatter } = parseFrontmatter(content, { source: agentName })
      const fields = parseAgentFields(frontmatter)
      expect(fields).not.toBeNull()

      // Assert parsed model chain deep-equals the table
      expect(fields?.model).toEqual(expected.model)

      // Assert parsed thinkingLevel equals the table (cast to string for comparison)
      expect(fields?.thinkingLevel as string | undefined).toBe(expected.thinkingLevel)
    })
  }

  test("exactly 11 agents are covered by the table", () => {
    expect(Object.keys(AGENT_MODEL_CHAIN_TABLE)).toHaveLength(11)
  })

  test("all model aliases are from ModelRoleAliasSchema (@smol, @task, @slow only)", () => {
    const validAliases = new Set(["@smol", "@task", "@slow"])
    for (const [, entry] of Object.entries(AGENT_MODEL_CHAIN_TABLE)) {
      for (const alias of entry.model) {
        expect(validAliases.has(alias)).toBe(true)
      }
    }
  })

  test("all thinkingLevel values are from the host set", () => {
    const validLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"])
    for (const [, entry] of Object.entries(AGENT_MODEL_CHAIN_TABLE)) {
      expect(validLevels.has(entry.thinkingLevel)).toBe(true)
    }
  })
})
