import { readFile } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import { loadCapability, type Skill } from "@oh-my-pi/pi-coding-agent/discovery"
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader"
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery"
import { z } from "zod"
import { sha256File } from "./artifact-hash"
import { assertExactProductRuntime } from "./product-runtime-contract"

class StagedRuntimeProbeError extends Error {
  override readonly name = "StagedRuntimeProbeError"
}

const installedManifestSchema = z.object({ version: z.string().min(1) })

function belongsTo(root: string, path: string | undefined): boolean {
  if (path === undefined || !isAbsolute(path)) return false
  const fromRoot = relative(root, path)
  return fromRoot.length === 0 || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
}

export async function probeStagedRuntime(
  installedRoot: string,
  project: string,
): Promise<{
  readonly agentNames: readonly string[]
  readonly commandNames: readonly string[]
  readonly extensionPaths: readonly string[]
  readonly handlerCounts: Readonly<Record<string, number>>
  readonly installedHashes: Readonly<Record<"extension" | "manifest", string>>
  readonly loaderErrors: readonly { readonly error: string; readonly path: string }[]
  readonly skillNames: readonly string[]
  readonly toolNames: readonly string[]
  readonly version: string
  readonly warnings: readonly unknown[]
}> {
  const extensionPath = join(installedRoot, "src", "index.ts")
  if (!(await Bun.file(extensionPath).exists())) {
    throw new StagedRuntimeProbeError("staged package is missing its declared extension entrypoint")
  }
  const [loader, skills, agents] = await Promise.all([
    loadExtensions([extensionPath], project),
    loadCapability<Skill>("skills", { cwd: project, providers: ["omp-plugins"] }),
    discoverAgents(project),
  ])
  const commandNames = loader.extensions
    .flatMap((extension) => [...extension.commands.keys()])
    .sort()
  const handlerCounts = Object.fromEntries(
    loader.extensions
      .flatMap((extension) => [...extension.handlers.entries()])
      .map(([event, handlers]): [string, number] => [event, handlers.length])
      .sort(([left], [right]) => left.localeCompare(right)),
  )
  const toolNames = loader.extensions.flatMap((extension) => [...extension.tools.keys()]).sort()
  const version = installedManifestSchema.parse(
    JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8")),
  ).version
  const runtime = {
    agentNames: agents.agents
      .filter((agent) => belongsTo(installedRoot, agent.filePath))
      .map((agent) => agent.name)
      .sort(),
    commandNames,
    extensionPaths: loader.extensions.map((extension) => extension.resolvedPath),
    handlerCounts,
    installedHashes: {
      extension: await sha256File(extensionPath),
      manifest: await sha256File(join(installedRoot, "package.json")),
    },
    loaderErrors: loader.errors,
    skillNames: skills.items
      .filter((skill) => belongsTo(installedRoot, skill.path))
      .map((skill) => skill.name)
      .sort(),
    toolNames,
    version,
    warnings: skills.warnings,
  }
  if (loader.errors.length === 0) {
    await assertExactProductRuntime({ inventory: { ...runtime, errors: loader.errors }, version })
  }
  return runtime
}
