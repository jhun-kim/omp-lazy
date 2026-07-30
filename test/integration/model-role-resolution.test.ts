import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery"
import { resolveWorkerModelRole } from "../../src/workflows/model-role-resolution"
import { removeTestTree } from "../fixtures/remove-test-tree"

const sandboxes: string[] = []

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map(removeTestTree))
})

const roleModels = {
  smol: "fixture/luna-low",
  task: "fixture/task-medium",
  slow: "fixture/sol-high",
} as const
const catalogModels = [
  { provider: "fixture", model: "luna-low" },
  { provider: "fixture", model: "task-medium" },
  { provider: "fixture", model: "sol-high" },
  { provider: "user", model: "custom" },
] as const

test("Given ordinary task.agentModelOverrides When a worker resolves Then the user override wins without input mutation", () => {
  // Given
  const overrides = { "omp-lazy-worker-low": "user/custom" }
  const disabledAgents = ["unrelated-agent"]
  const before = JSON.stringify({ overrides, disabledAgents })

  // When
  const receipt = resolveWorkerModelRole({
    agentName: "omp-lazy-worker-low",
    agentModel: "@smol",
    agentModelOverrides: overrides,
    roleModels,
    catalogModels,
    availableProviders: ["fixture", "user"],
  })

  // Then
  expect(receipt).toEqual({
    schemaVersion: 1,
    status: "PASS",
    agentName: "omp-lazy-worker-low",
    source: "user_override",
    selector: "user/custom",
    role: null,
    provider: "user",
    model: "custom",
  })
  expect(JSON.stringify({ overrides, disabledAgents })).toBe(before)
})

test("Given invalid role, unavailable provider, or missing model When resolved Then each is BLOCKED with a stable code", () => {
  // Given / When
  const invalid = resolveWorkerModelRole({
    agentName: "omp-lazy-worker-medium",
    agentModel: "@task",
    agentModelOverrides: { "omp-lazy-worker-medium": "@invalid" },
    roleModels,
    catalogModels,
    availableProviders: ["fixture"],
  })
  const unavailableProvider = resolveWorkerModelRole({
    agentName: "omp-lazy-worker-medium",
    agentModel: "@task",
    agentModelOverrides: { "omp-lazy-worker-medium": "user/custom" },
    roleModels,
    catalogModels,
    availableProviders: ["fixture"],
  })
  const unavailableModel = resolveWorkerModelRole({
    agentName: "omp-lazy-worker-medium",
    agentModel: "@task",
    agentModelOverrides: { "omp-lazy-worker-medium": "fixture/missing" },
    roleModels,
    catalogModels,
    availableProviders: ["fixture"],
  })

  // Then
  expect(invalid).toMatchObject({ status: "BLOCKED", code: "invalid_model_role" })
  expect(unavailableProvider).toMatchObject({ status: "BLOCKED", code: "provider_unavailable" })
  expect(unavailableModel).toMatchObject({ status: "BLOCKED", code: "model_unavailable" })
})

test("Given the shipped worker agents When discovered and resolved Then their exact roles map low, task, and slow", async () => {
  // Given
  const sandbox = await mkdtemp(join(tmpdir(), "omp-lazy-model-role-"))
  sandboxes.push(sandbox)
  const home = join(sandbox, "home")
  await mkdir(join(sandbox, ".omp"), { recursive: true })
  await mkdir(home, { recursive: true })
  await writeFile(
    join(sandbox, ".omp", "settings.json"),
    JSON.stringify({ extensions: [process.cwd()] }),
  )
  const { agents } = await discoverAgents(sandbox, home)
  const expected = [
    ["omp-lazy-worker-low", "@smol", "luna-low"],
    ["omp-lazy-worker-medium", "@task", "task-medium"],
    ["omp-lazy-worker-high", "@slow", "sol-high"],
  ] as const

  // When
  const receipts = expected.map(([name]) => {
    const agent = agents.find((candidate) => candidate.name === name)
    return {
      model: agent?.model,
      receipt: resolveWorkerModelRole({
        agentName: name,
        agentModel: agent?.model,
        agentModelOverrides: {},
        roleModels,
        catalogModels,
        availableProviders: ["fixture"],
      }),
    }
  })

  // Then - agents now declare model: arrays (todo 18)
  expect(receipts.map((entry) => entry.model)).toEqual([
    ["@smol", "@task"],
    ["@task", "@slow"],
    ["@slow", "@task"],
  ])
  expect(receipts.map((entry) => entry.receipt.status)).toEqual(["PASS", "PASS", "PASS"])
  expect(
    receipts.map((entry) => (entry.receipt.status === "PASS" ? entry.receipt.model : null)),
  ).toEqual(expected.map(([, , model]) => model))
})
