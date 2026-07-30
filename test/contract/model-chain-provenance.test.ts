/**
 * Contract test: model chain resolution with per-attempt provenance recording.
 * Todo 19 - Resolve chains in order and record per-attempt provenance.
 *
 * Tests:
 * - First alias unresolvable then second resolvable yields PASS with attempt index 1
 *   and a recorded failed attempt 0
 * - A fully unresolvable chain yields BLOCKED model_unavailable with every attempt recorded
 * - All 11 agents have a default role equal to their table's first alias
 * - The provenance file path matches the todo 4 pattern exactly
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveWorkerModelChain } from "../../src/workflows/model-role-resolution"

const sandboxes: string[] = []

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((s) => rm(s, { recursive: true, force: true })))
})

const roleModels = {
  smol: "fixture/luna-low",
  task: "fixture/task-medium",
  slow: "fixture/sol-high",
} as const

const fullCatalog = [
  { provider: "fixture", model: "luna-low" },
  { provider: "fixture", model: "task-medium" },
  { provider: "fixture", model: "sol-high" },
] as const

describe("model chain resolution with provenance (todo 19)", () => {
  test("first rung unresolvable then second resolvable yields PASS with attempt index 1 and a recorded failed attempt 0", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "omp-lazy-chain-"))
    sandboxes.push(sandbox)
    const stateRoot = join(sandbox, ".omo", "omp-lazy")
    await mkdir(join(stateRoot, "model-chain-provenance"), { recursive: true })

    // Chain: ["@slow", "@task"] with @slow's provider unavailable
    // Since both @slow and @task resolve to "fixture/" provider which IS available,
    // and both models are in the catalog, the first rung should succeed.
    // To test first-rung-fails, we need to make the first rung's provider unavailable.
    // Let's use a different setup:
    const result2 = await resolveWorkerModelChain({
      agentName: "omp-lazy-worker-high",
      chain: ["@slow", "@task"],
      agentModelOverrides: {},
      roleModels: {
        smol: "fixture/luna-low",
        task: "fixture/task-medium",
        slow: "missing-provider/sol-high", // first rung provider not available
      },
      catalogModels: [...fullCatalog, { provider: "missing-provider", model: "sol-high" }],
      availableProviders: ["fixture"], // only fixture is available
      runId: "testRun02",
      stateRoot,
    })

    expect(result2.receipt.status).toBe("PASS")
    expect(result2.receipt.schemaVersion).toBe(2)
    if (result2.receipt.status === "PASS" && result2.receipt.schemaVersion === 2) {
      expect(result2.receipt.attemptIndex).toBe(1)
      expect(result2.receipt.role).toBe("task")
      expect(result2.receipt.selector).toBe("@task")
    }

    // Provenance should record both attempts
    expect(result2.provenance).not.toBeNull()
    expect(result2.provenance?.schemaVersion).toBe(2)
    expect(result2.provenance?.attempts).toHaveLength(2)
    expect(result2.provenance?.attempts[0]?.attemptIndex).toBe(0)
    expect(result2.provenance?.attempts[0]?.outcome).toBe("provider_unavailable")
    expect(result2.provenance?.attempts[1]?.attemptIndex).toBe(1)
    expect(result2.provenance?.attempts[1]?.outcome).toBe("resolved")
  })

  test("a fully unresolvable chain yields BLOCKED model_unavailable with every attempt recorded", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "omp-lazy-chain-"))
    sandboxes.push(sandbox)
    const stateRoot = join(sandbox, ".omo", "omp-lazy")
    await mkdir(join(stateRoot, "model-chain-provenance"), { recursive: true })

    const result = await resolveWorkerModelChain({
      agentName: "omp-lazy-worker-high",
      chain: ["@slow", "@task"],
      agentModelOverrides: {},
      roleModels,
      catalogModels: [], // empty catalog - nothing can resolve
      availableProviders: ["fixture"],
      runId: "testRunBlocked",
      stateRoot,
    })

    expect(result.receipt.status).toBe("BLOCKED")
    expect(result.receipt.schemaVersion).toBe(2)
    if (result.receipt.status === "BLOCKED" && result.receipt.schemaVersion === 2) {
      expect(result.receipt.code).toBe("model_unavailable")
      expect(result.receipt.attempts).toHaveLength(2)
      expect(result.receipt.attempts[0]?.attemptIndex).toBe(0)
      expect(result.receipt.attempts[0]?.outcome).not.toBe("resolved")
      expect(result.receipt.attempts[1]?.attemptIndex).toBe(1)
      expect(result.receipt.attempts[1]?.outcome).not.toBe("resolved")
    }

    // Provenance written
    expect(result.provenance).not.toBeNull()
    expect(result.provenance?.attempts).toHaveLength(2)
  })

  test("all 11 agents have a default role equal to their table first alias", async () => {
    const { resolveAgentDefaultRole } = await import("../../src/workflows/model-role-resolution")
    const expectedDefaults: Record<string, string> = {
      "omp-lazy-worker-low": "@smol",
      "omp-lazy-worker-medium": "@task",
      "omp-lazy-worker-high": "@slow",
      "omp-lazy-explorer": "@smol",
      "omp-lazy-librarian": "@smol",
      "omp-lazy-researcher": "@task",
      "omp-lazy-planner": "@slow",
      "omp-lazy-metis": "@slow",
      "omp-lazy-momus": "@slow",
      "omp-lazy-qa": "@task",
      "omp-lazy-reviewer": "@slow",
    }

    for (const [agent, expectedRole] of Object.entries(expectedDefaults)) {
      const resolved = resolveAgentDefaultRole(agent)
      expect(resolved).toBe(expectedRole)
    }
    // Exactly 11
    expect(Object.keys(expectedDefaults)).toHaveLength(11)
  })

  test("provenance file path matches the todo 4 pattern exactly", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "omp-lazy-chain-"))
    sandboxes.push(sandbox)
    const stateRoot = join(sandbox, ".omo", "omp-lazy")
    await mkdir(join(stateRoot, "model-chain-provenance"), { recursive: true })
    const runId = "testRunPath01"

    await resolveWorkerModelChain({
      agentName: "omp-lazy-worker-low",
      chain: ["@smol", "@task"],
      agentModelOverrides: {},
      roleModels,
      catalogModels: fullCatalog,
      availableProviders: ["fixture"],
      runId,
      stateRoot,
    })

    // The provenance file should be at model-chain-provenance/<runId>.json
    const expectedPath = join(stateRoot, "model-chain-provenance", `${runId}.json`)
    const raw = await readFile(expectedPath, "utf8")
    const parsed = JSON.parse(raw)
    expect(parsed.schemaVersion).toBe(2)
    expect(parsed.runId).toBe(runId)
    expect(parsed.agentName).toBe("omp-lazy-worker-low")
    expect(parsed.attempts).toBeArray()
    // No vendor model id in evidence
    for (const attempt of parsed.attempts) {
      expect(attempt).not.toHaveProperty("model")
      expect(attempt).not.toHaveProperty("provider")
    }
  })

  test("provenance record does not contain a vendor model id", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "omp-lazy-chain-"))
    sandboxes.push(sandbox)
    const stateRoot = join(sandbox, ".omo", "omp-lazy")
    await mkdir(join(stateRoot, "model-chain-provenance"), { recursive: true })

    await resolveWorkerModelChain({
      agentName: "omp-lazy-worker-low",
      chain: ["@smol", "@task"],
      agentModelOverrides: {},
      roleModels,
      catalogModels: fullCatalog,
      availableProviders: ["fixture"],
      runId: "testRunNoVendor",
      stateRoot,
    })

    const expectedPath = join(stateRoot, "model-chain-provenance", "testRunNoVendor.json")
    const raw = await readFile(expectedPath, "utf8")
    // The raw bytes should not contain any fixture model names
    expect(raw).not.toContain("luna-low")
    expect(raw).not.toContain("task-medium")
    expect(raw).not.toContain("sol-high")
  })
})
