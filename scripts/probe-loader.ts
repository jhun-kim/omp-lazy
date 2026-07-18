import { realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader"
import { z } from "zod"
import {
  assertExactProductRuntime,
  loadRuntimeInventoryFromManifest,
} from "./product-runtime-contract"

const argumentsSchema = z.union([
  z.tuple([]),
  z.tuple([z.literal("--extension"), z.string().min(1), z.literal("--cwd"), z.string().min(1)]),
])

async function main(): Promise<void> {
  const parsed = argumentsSchema.parse(Bun.argv.slice(2))
  const cwd = await realpath(resolve(parsed.length === 0 ? process.cwd() : parsed[3]))
  if (parsed.length === 0) {
    const receipt = await assertExactProductRuntime(
      await loadRuntimeInventoryFromManifest(join(cwd, "package.json")),
    )
    process.stdout.write(
      `${JSON.stringify({
        commandNames: receipt.inventory.commandNames,
        errors: receipt.inventory.errors,
        extensionPaths: receipt.inventory.extensionPaths,
        handlerCounts: receipt.inventory.handlerCounts,
        mode: "product",
        toolNames: receipt.inventory.toolNames,
        version: receipt.version,
      })}\n`,
    )
    return
  }
  const manifest = { extensionPaths: [resolve(parsed[1])], packageRoot: cwd }
  const result = await loadExtensions([...manifest.extensionPaths], manifest.packageRoot)
  const commandNames = result.extensions
    .flatMap((extension) => [...extension.commands.keys()])
    .sort()
  const toolNames = result.extensions.flatMap((extension) => [...extension.tools.keys()]).sort()
  const handlerEntries = result.extensions
    .flatMap((extension) => [...extension.handlers.entries()])
    .map(([event, handlers]): [string, number] => [event, handlers.length])
    .sort((left, right) => left[0].localeCompare(right[0]))
  const handlerCounts = Object.fromEntries(handlerEntries)
  process.stdout.write(
    `${JSON.stringify({
      commandNames,
      errors: result.errors,
      extensionPaths: result.extensions.map((extension) => extension.resolvedPath),
      handlerCounts,
      mode: "fixture",
      toolNames,
    })}\n`,
  )
  if (result.errors.length > 0 || result.extensions.length !== 1) process.exitCode = 1
}

// no-excuse-ok: catch — loader probe is a CLI boundary.
try {
  await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
