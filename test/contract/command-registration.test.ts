import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions"
import { expectedProductRuntime } from "../../scripts/product-runtime-contract"
import { COMMAND_DEFINITIONS, COMMAND_REGISTRATIONS } from "../../src/commands/command-definitions"
import { diagnoseCommandCollisions } from "../../src/commands/register-workflow-commands"

const EXPECTED_GRAMMAR = {
  teammode: [
    "create <team-name>",
    "status [team-name]",
    "archive <team-name>",
    "delete <team-name>",
    "resume <team-name>",
  ],
  start_work: [
    "",
    "start [plan-path]",
    "status [run-id]",
    "pause [run-id]",
    "resume [run-id]",
    "cancel [run-id]",
    "adopt <run-id>",
    "reconcile <run-id> <plan-path>",
    "status --repair <run-id>",
    "status --repair-lock <nonce> --confirm",
  ],
  ultrawork: ["[auto|light|heavy] [-- <task-text>]"],
  ulw_loop: [
    "create <objective-text>",
    "status [run-id]",
    "pause [run-id]",
    "resume [run-id]",
    "cancel [run-id]",
    "adopt <run-id>",
    "checkpoint <run-id> <criterion-id> <evidence-path>",
    "steer <run-id> <steering-json-path>",
  ],
  ulw_plan: ["[-- <brief>]"],
  ulw_research: ["<query-text>"],
  doctor: ["[--json] [--deep]"],
  report_bug: ["[--target auto|omp-lazy|omp] [--dry-run] <summary-text>"],
  contribute_bug_fix: ["--dry-run <issue-or-bug-ref>"],
} as const

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

async function fixtureExtension(body: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omp-lazy-command-extension-"))
  temporaryPaths.push(root)
  const path = join(root, "extension.ts")
  await writeFile(path, body)
  return path
}

async function loadProductCommand(name: string) {
  const loaded = await loadExtensions([join(process.cwd(), "src", "index.ts")], process.cwd())
  expect(loaded.errors).toEqual([])
  const product = loaded.extensions[0]
  if (product === undefined) throw new Error("public loader returned no product extension")
  const command = product.commands.get(name)
  if (command === undefined) throw new Error(`public loader returned no ${name} command`)
  return { command, runtime: loaded.runtime }
}

describe("authoritative command catalog", () => {
  test("contains the exact canonical and alias inventory once", () => {
    expect(COMMAND_REGISTRATIONS.map((entry) => entry.command.slice(1)).sort()).toEqual(
      expectedProductRuntime.commandNames,
    )
    expect(new Set(COMMAND_REGISTRATIONS.map((entry) => entry.command)).size).toBe(19)
    expect(COMMAND_REGISTRATIONS.find((entry) => entry.command === "/ulw")?.workflow).toBe(
      "ultrawork",
    )
  })

  test("is the single source of every control grammar row", () => {
    expect(
      Object.fromEntries(COMMAND_DEFINITIONS.map((entry) => [entry.workflow, entry.grammar])),
    ).toEqual(EXPECTED_GRAMMAR)
  })
})

describe("public OMP registration inventory", () => {
  test("loads all 19 registrations through the public loader", async () => {
    const moduleUrl = pathToFileURL(
      join(process.cwd(), "src", "commands", "register-workflow-commands.ts"),
    ).href
    const extension = await fixtureExtension(`
      import { registerWorkflowCommands } from ${JSON.stringify(moduleUrl)}
      export default function fixture(api) {
        registerWorkflowCommands(api, { execute: async () => {} })
      }
    `)
    const loaded = await loadExtensions([extension], process.cwd())

    expect(loaded.errors).toEqual([])
    const product = loaded.extensions[0]
    if (product === undefined) throw new Error("public loader returned no extension")
    expect([...product.commands.keys()].sort()).toEqual(expectedProductRuntime.commandNames)
  })

  test("reports built-in and later-extension collisions as non-PASS", async () => {
    const moduleUrl = pathToFileURL(
      join(process.cwd(), "src", "commands", "register-workflow-commands.ts"),
    ).href
    const product = await fixtureExtension(`
      import { registerWorkflowCommands } from ${JSON.stringify(moduleUrl)}
      export default function fixture(api) {
        registerWorkflowCommands(api, { execute: async () => {} })
      }
    `)
    const later = await fixtureExtension(`
      export default function collision(api) {
        api.registerCommand("ulw", { handler: async () => {} })
      }
    `)
    const loaded = await loadExtensions([product, later], process.cwd())
    const inventories = loaded.extensions.map((extension) => extension.commands)

    expect(loaded.errors).toEqual([])
    expect(diagnoseCommandCollisions(inventories.slice(0, 1), ["teammode"]).status).toBe("FAIL")
    expect(diagnoseCommandCollisions(inventories, []).status).toBe("FAIL")
    expect(diagnoseCommandCollisions(inventories.slice(0, 1), []).status).toBe("PASS")
  })

  test("starts a valid workflow activation through default public message delivery", async () => {
    // Given: the product extension registered through OMP's public loader while the host is idle.
    const { command, runtime } = await loadProductCommand("ulw")
    const deliveries: Array<{ readonly content: unknown; readonly options: unknown }> = []
    runtime.sendUserMessage = (content, options) => deliveries.push({ content, options })

    // When: a valid workflow command is invoked through its public registration.
    await Reflect.apply(command.handler, undefined, [
      "heavy -- verify public delivery",
      { cwd: process.cwd(), sessionManager: { getSessionId: () => "public-valid-session" } },
    ])

    // Then: OMP receives the activation without an explicit queued-delivery mode.
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]?.content).toContain("workflow ultrawork")
    expect(deliveries[0]?.options).toBeUndefined()
  })

  test("rejects malformed public workflow grammar without sending a message", async () => {
    // Given: the product command registered through OMP's public loader.
    const { command, runtime } = await loadProductCommand("ulw")
    const deliveries: unknown[] = []
    runtime.sendUserMessage = (content) => deliveries.push(content)

    // When / Then: malformed grammar is rejected before public message delivery.
    await expect(
      Reflect.apply(command.handler, undefined, [
        "--not-in-catalog",
        { cwd: process.cwd(), sessionManager: { getSessionId: () => "public-invalid-session" } },
      ]),
    ).rejects.toThrow("invalid grammar for /ulw")
    expect(deliveries).toEqual([])
  })
})
