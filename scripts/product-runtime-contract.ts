import { readdir, readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader"
import { z } from "zod"
import { COMMAND_REGISTRATIONS } from "../src/commands/command-definitions"
import { WORKER_RESULT_TOOL_NAME } from "../src/tools/register-worker-result-tool"

const manifestSchema = z.object({
  name: z.literal("omp-lazy"),
  version: z.string().min(1),
  omp: z.strictObject({ extensions: z.array(z.string().min(1)).readonly() }),
})

const runtimeInventorySchema = z.strictObject({
  agentNames: z.array(z.string().min(1)).readonly(),
  commandNames: z.array(z.string().min(1)).readonly(),
  errors: z.array(z.unknown()).readonly(),
  extensionPaths: z.array(z.string().min(1)).readonly(),
  handlerCounts: z.record(z.string().min(1), z.number().int().nonnegative()).readonly(),
  skillNames: z.array(z.string().min(1)).readonly(),
  toolNames: z.array(z.string().min(1)).readonly(),
  warnings: z.array(z.unknown()).readonly(),
})

export const expectedProductRuntime = {
  agentNames: [
    "omp-lazy-explorer",
    "omp-lazy-librarian",
    "omp-lazy-metis",
    "omp-lazy-momus",
    "omp-lazy-planner",
    "omp-lazy-qa",
    "omp-lazy-researcher",
    "omp-lazy-reviewer",
    "omp-lazy-worker-high",
    "omp-lazy-worker-low",
    "omp-lazy-worker-medium",
  ],
  commandNames: COMMAND_REGISTRATIONS.map((registration) => registration.command.slice(1)).sort(),
  handlerCounts: {
    before_agent_start: 1,
    input: 1,
    session_stop: 1,
    tool_call: 1,
    tool_result: 1,
  },
  skillNames: [
    "lcx-contribute-bug-fix",
    "lcx-doctor",
    "lcx-report-bug",
    "start-work",
    "teammode",
    "ultrawork",
    "ulw-loop",
    "ulw-plan",
    "ulw-research",
  ],
  toolNames: [WORKER_RESULT_TOOL_NAME],
  warnings: [],
} as const

export type ProductRuntimeInventory = z.infer<typeof runtimeInventorySchema>

export type ProductRuntimeReceipt = {
  readonly inventory: ProductRuntimeInventory
  readonly version: string
}

export class ProductRuntimeContractError extends Error {
  override readonly name = "ProductRuntimeContractError"
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ")
}

function requireEqual(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ProductRuntimeContractError(
      `${label} inventory mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    )
  }
}

function findDuplicate(label: string, values: readonly string[]): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) {
      throw new ProductRuntimeContractError(`duplicate ${label} registration: ${value}`)
    }
    seen.add(value)
  }
}

async function runtimeDirectoryNames(
  root: string,
  directory: "agents" | "skills",
): Promise<readonly string[]> {
  try {
    const entries = await readdir(resolve(root, directory), { withFileTypes: true })
    return entries
      .filter((entry) => (directory === "skills" ? entry.isDirectory() : entry.isFile()))
      .map((entry) => (directory === "agents" ? entry.name.replace(/\.md$/, "") : entry.name))
      .sort()
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    throw error
  }
}

export async function resolveManifestExtensionPaths(packageJsonPath: string): Promise<{
  readonly extensionPaths: readonly string[]
  readonly packageRoot: string
  readonly version: string
}> {
  const packageRoot = dirname(packageJsonPath)
  const rawManifest: unknown = JSON.parse(await readFile(packageJsonPath, "utf8"))
  const manifest = manifestSchema.safeParse(rawManifest)
  if (!manifest.success) {
    throw new ProductRuntimeContractError(
      `invalid package manifest: ${formatZodIssues(manifest.error)}`,
    )
  }
  return {
    extensionPaths: manifest.data.omp.extensions.map((entry) => resolve(packageRoot, entry)),
    packageRoot,
    version: manifest.data.version,
  }
}

export async function loadRuntimeInventoryFromManifest(
  packageJsonPath: string,
): Promise<ProductRuntimeReceipt> {
  const manifest = await resolveManifestExtensionPaths(packageJsonPath)
  const loaded = await loadExtensions([...manifest.extensionPaths], manifest.packageRoot)
  const agentNames = await runtimeDirectoryNames(manifest.packageRoot, "agents")
  const skillNames = await runtimeDirectoryNames(manifest.packageRoot, "skills")
  const inventory = runtimeInventorySchema.parse({
    agentNames,
    commandNames: loaded.extensions.flatMap((extension) => [...extension.commands.keys()]).sort(),
    errors: loaded.errors,
    extensionPaths: loaded.extensions.map((extension) => extension.resolvedPath),
    handlerCounts: Object.fromEntries(
      loaded.extensions
        .flatMap((extension) => [...extension.handlers.entries()])
        .map(([event, handlers]): [string, number] => [event, handlers.length])
        .sort((left, right) => left[0].localeCompare(right[0])),
    ),
    skillNames,
    toolNames: loaded.extensions.flatMap((extension) => [...extension.tools.keys()]).sort(),
    warnings: [],
  })
  return { inventory, version: manifest.version }
}

export async function assertExactProductRuntime(
  receipt: ProductRuntimeReceipt,
): Promise<ProductRuntimeReceipt> {
  requireEqual("loader errors", receipt.inventory.errors, [])
  findDuplicate("command", receipt.inventory.commandNames)
  findDuplicate("tool", receipt.inventory.toolNames)
  requireEqual("tools", receipt.inventory.toolNames, expectedProductRuntime.toolNames)
  requireEqual("commands", receipt.inventory.commandNames, expectedProductRuntime.commandNames)
  requireEqual("handlers", receipt.inventory.handlerCounts, expectedProductRuntime.handlerCounts)
  requireEqual("warnings", receipt.inventory.warnings, expectedProductRuntime.warnings)
  return receipt
}
