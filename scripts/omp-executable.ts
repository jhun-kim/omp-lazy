import { realpath, stat } from "node:fs/promises"
import { extname, join, resolve } from "node:path"
import { sha256File } from "./artifact-hash"

export const expectedOmpVersion = "16.4.8"
export const defaultLocalOmpExecutable = join(
  import.meta.dir,
  "..",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "omp.exe" : "omp",
)

export type OmpExecutableErrorCode = "missing_executable" | "unsupported_host_version"

export type PinnedOmpExecutable = {
  readonly path: string
  readonly sha256: string
  readonly version: typeof expectedOmpVersion
}

export class OmpExecutableError extends Error {
  override readonly name = "OmpExecutableError"

  constructor(
    readonly code: OmpExecutableErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
  }
}

export class OmpExecutableArgumentError extends Error {
  override readonly name = "OmpExecutableArgumentError"
}

export function ompCommand(executable: string, argv: readonly string[]): readonly string[] {
  const extension = extname(executable).toLowerCase()
  if (process.platform === "win32" && (extension === ".cmd" || extension === ".bat")) {
    const commandInterpreter = Object.entries(process.env).find(
      ([key]) => key.toLowerCase() === "comspec",
    )?.[1]
    return [commandInterpreter ?? "cmd.exe", "/d", "/s", "/c", "call", executable, ...argv]
  }
  return [executable, ...argv]
}

export function parseOmpExecutableOption(argv: readonly string[]): {
  readonly ompPath: string
  readonly rest: readonly string[]
} {
  if (argv.length === 0) return { ompPath: defaultLocalOmpExecutable, rest: [] }
  if (argv[0] !== "--omp-exe" || argv[1] === undefined) {
    throw new OmpExecutableArgumentError("usage: [--omp-exe <path>]")
  }
  return { ompPath: argv[1], rest: argv.slice(2) }
}

export async function assertPinnedOmpExecutable(path: string): Promise<PinnedOmpExecutable> {
  const absolutePath = resolve(path)
  try {
    const metadata = await stat(absolutePath)
    if (!metadata.isFile())
      throw new OmpExecutableError(
        "missing_executable",
        `OMP executable not found: ${absolutePath}`,
      )
  } catch (error) {
    if (error instanceof OmpExecutableError) throw error
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new OmpExecutableError(
        "missing_executable",
        `OMP executable not found: ${absolutePath}`,
      )
    }
    throw error
  }

  const resolvedPath = await realpath(absolutePath)
  const versionProcess = Bun.spawnSync([...ompCommand(resolvedPath, ["--version"])], {
    stderr: "pipe",
    stdout: "pipe",
  })
  const versionOutput = new TextDecoder().decode(versionProcess.stdout).trim()
  const version = versionOutput.replace(/^omp\//, "")
  if (versionProcess.exitCode !== 0 || version !== expectedOmpVersion) {
    throw new OmpExecutableError(
      "unsupported_host_version",
      `expected OMP ${expectedOmpVersion}, received ${versionOutput}`,
    )
  }
  return { path: resolvedPath, sha256: await sha256File(resolvedPath), version: expectedOmpVersion }
}
