import { readFile, realpath } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import { z } from "zod"

const TYPESCRIPT_VERSION = "6.0.3"

const argumentsSchema = z.tuple([z.literal("--noEmit")])
const packageManifestSchema = z.object({
  devDependencies: z.object({ typescript: z.literal(TYPESCRIPT_VERSION) }),
})
const installedTypeScriptSchema = z.object({
  bin: z.object({ tsc: z.literal("./bin/tsc") }),
  name: z.literal("typescript"),
  version: z.literal(TYPESCRIPT_VERSION),
})

class LocalCompilerError extends Error {
  override readonly name = "LocalCompilerError"
}

function assertContained(root: string, candidate: string, label: string): void {
  const pathFromRoot = relative(root, candidate)
  if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new LocalCompilerError(`${label} escaped the project root`)
  }
}

async function requireLocalCompiler(projectRoot: string): Promise<string> {
  packageManifestSchema.parse(JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")))

  const packageRoot = await realpath(join(projectRoot, "node_modules", "typescript"))
  assertContained(projectRoot, packageRoot, "local TypeScript package")
  installedTypeScriptSchema.parse(
    JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")),
  )

  const compiler = await realpath(join(packageRoot, "lib", "tsc.js"))
  assertContained(packageRoot, compiler, "local TypeScript compiler")
  return compiler
}

async function main(): Promise<void> {
  const parsedArguments = argumentsSchema.safeParse(Bun.argv.slice(2))
  if (!parsedArguments.success) throw new LocalCompilerError("expected exactly --noEmit")

  const projectRoot = await realpath(process.cwd())
  const compiler = await requireLocalCompiler(projectRoot)
  const child = Bun.spawn([process.execPath, compiler, ...parsedArguments.data], {
    cwd: projectRoot,
    env: process.env,
    stderr: "inherit",
    stdout: "inherit",
  })
  process.exitCode = await child.exited
}

// no-excuse-ok: catch — CLI boundary converts local compiler authority failures to stderr.
try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`local TypeScript compiler authority rejected: ${message}\n`)
  process.exitCode = 1
}
