import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { assertExactProductDiscovery } from "../../scripts/product-discovery-contract"
import { expectedProductRuntime } from "../../scripts/product-runtime-contract"

const compactOutputAgents = {
  "omp-lazy-metis": ["verdict", "receiptId", "artifactHashes"],
  "omp-lazy-momus": ["verdict", "receiptId", "artifactHashes"],
  "omp-lazy-qa": ["status", "receiptId", "scenarioIds", "artifactHashes"],
  "omp-lazy-reviewer": ["verdict", "receiptId", "artifactHashes"],
  "omp-lazy-worker-high": ["status", "receiptId", "artifactHashes"],
  "omp-lazy-worker-low": ["status", "receiptId", "artifactHashes"],
  "omp-lazy-worker-medium": ["status", "receiptId", "artifactHashes"],
} as const

function frontmatter(source: string): string {
  const end = source.indexOf("\n---", 4)
  return end === -1 ? "" : source.slice(4, end)
}

function description(source: string): string {
  const line = frontmatter(source)
    .split("\n")
    .find((candidate) => candidate.startsWith("description:"))
  return line?.slice("description:".length).trim() ?? ""
}

describe("public agent roster budget", () => {
  test("Given product discovery When agents load Then every public agent remains visible with a short description", async () => {
    // Given / When
    const discovered = await assertExactProductDiscovery(process.cwd())
    const descriptions = await Promise.all(
      discovered.productAgentNames.map(async (name) =>
        description(await readFile(join(process.cwd(), "agents", `${name}.md`), "utf8")),
      ),
    )

    // Then
    expect(discovered.productAgentNames).toEqual(expectedProductRuntime.agentNames)
    for (const value of descriptions)
      expect(value.trim().split(/\s+/u).length).toBeLessThanOrEqual(12)
  })

  test("Given worker critic and QA agents When outputs are inspected Then only IDs and artifact hashes carry evidence", async () => {
    // Given
    const directory = join(process.cwd(), "agents")
    const files = await readdir(directory)

    // When / Then
    for (const [agentName, fields] of Object.entries(compactOutputAgents)) {
      expect(files).toContain(`${agentName}.md`)
      const source = await readFile(join(directory, `${agentName}.md`), "utf8")
      const metadata = frontmatter(source)
      expect(description(source).split(/\s+/u).length).toBeLessThanOrEqual(12)
      for (const field of fields) expect(metadata).toContain(field)
      expect(metadata).not.toMatch(/\b(summary|findings|observation|changedFiles|tests|cleanup)\b/u)
    }
  })
})
