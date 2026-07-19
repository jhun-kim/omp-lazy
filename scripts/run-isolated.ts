import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { z } from "zod"
import {
  cleanupProcessTree,
  POST_KILL_COMPLETION_MS,
  ProcessTreeCleanupError,
  settleWithin,
} from "./process-tree-cleanup"

const profileSchema = z.enum(["unit", "integration", "omp"])
const positiveIntegerSchema = z.coerce.number().int().positive()

type RunnerArguments = {
  readonly argv: readonly [string, ...string[]]
  readonly cwd: string
  readonly profile: z.infer<typeof profileSchema>
  readonly timeoutMs: number
}

type CleanupReceipt = {
  readonly processTree: "complete"
  readonly sandbox: "complete"
}

type RunReceipt = {
  readonly cleanup: CleanupReceipt
  readonly durationMs: number
  readonly envProfile: z.infer<typeof profileSchema>
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
  readonly timedOut: boolean
}

class RunnerArgumentError extends Error {
  override readonly name = "RunnerArgumentError"
}

function parseArguments(argv: readonly string[]): RunnerArguments {
  const separator = argv.indexOf("--")
  if (separator < 0) throw new RunnerArgumentError("missing -- command separator")

  const options = argv.slice(0, separator)
  const command = argv.slice(separator + 1)
  if (command.length === 0) throw new RunnerArgumentError("missing executable")

  const values = new Map<string, string>()
  for (let index = 0; index < options.length; index += 2) {
    const key = options[index]
    const value = options[index + 1]
    if (key === undefined || value === undefined) {
      throw new RunnerArgumentError("runner options require key-value pairs")
    }
    if (!new Set(["--timeout-ms", "--cwd", "--env-profile"]).has(key)) {
      throw new RunnerArgumentError(`unknown runner option: ${key}`)
    }
    if (values.has(key)) throw new RunnerArgumentError(`duplicate runner option: ${key}`)
    values.set(key, value)
  }

  const timeoutMs = positiveIntegerSchema.parse(values.get("--timeout-ms"))
  const cwd = z.string().min(1).parse(values.get("--cwd"))
  const profile = profileSchema.parse(values.get("--env-profile"))
  const executable = command[0]
  if (executable === undefined) throw new RunnerArgumentError("missing executable")
  return { argv: [executable, ...command.slice(1)], cwd, profile, timeoutMs }
}

function inherited(
  name: "SystemRoot" | "ComSpec" | "PATH" | "PATHEXT" | "HOME" | "USERPROFILE",
): string {
  const pair = Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase())
  return pair?.[1] ?? ""
}

function assertContained(parent: string, child: string): void {
  const pathFromParent = relative(parent, child)
  if (pathFromParent.startsWith("..") || isAbsolute(pathFromParent)) {
    throw new RunnerArgumentError(`isolated root escaped cwd: ${child}`)
  }
}

async function createEnvironment(
  cwd: string,
  profile: z.infer<typeof profileSchema>,
): Promise<{
  readonly environment: Readonly<Record<string, string>>
  readonly sandboxRoot: string
}> {
  const hostProfile = inherited("USERPROFILE") || inherited("HOME")
  if (hostProfile.length === 0) throw new RunnerArgumentError("host profile is unavailable")
  const sandboxRoot = await mkdtemp(join(cwd, ".omp-lazy-isolated-"))
  assertContained(cwd, sandboxRoot)
  const home = join(sandboxRoot, "home")
  const temp = join(sandboxRoot, "temp")
  const paths = [
    home,
    temp,
    join(home, ".omp", "agent"),
    join(sandboxRoot, "worktrees"),
    join(sandboxRoot, "xdg", "data"),
    join(sandboxRoot, "xdg", "state"),
    join(sandboxRoot, "xdg", "cache"),
    join(sandboxRoot, "cache", "bun"),
    join(sandboxRoot, "cache", "npm"),
  ]
  for (const path of paths) {
    assertContained(sandboxRoot, path)
    await mkdir(path, { recursive: true })
  }
  const npmConfig = join(sandboxRoot, "npmrc")
  await writeFile(npmConfig, "", { flag: "wx" })

  return {
    environment: {
      SystemRoot: inherited("SystemRoot"),
      ComSpec: inherited("ComSpec"),
      PATH: inherited("PATH"),
      PATHEXT: inherited("PATHEXT"),
      USERPROFILE: home,
      HOME: home,
      PI_CODING_AGENT_DIR: join(home, ".omp", "agent"),
      PI_CONFIG_DIR: ".omp",
      ...(profile === "omp" ? { OMP_LAZY_HOST_PROFILE: hostProfile } : {}),
      OMP_WORKTREE_DIR: join(sandboxRoot, "worktrees"),
      XDG_DATA_HOME: join(sandboxRoot, "xdg", "data"),
      XDG_STATE_HOME: join(sandboxRoot, "xdg", "state"),
      XDG_CACHE_HOME: join(sandboxRoot, "xdg", "cache"),
      TEMP: temp,
      TMP: temp,
      BUN_INSTALL_CACHE_DIR: join(sandboxRoot, "cache", "bun"),
      npm_config_cache: join(sandboxRoot, "cache", "npm"),
      npm_config_userconfig: npmConfig,
    },
    sandboxRoot,
  }
}

function collectedZeroTests(argv: readonly string[], output: string): boolean {
  if (argv[0] !== "bun" || argv[1] !== "test") return false
  return /\b0 pass\b|\b0 tests?\b|No tests found/i.test(output)
}

async function run(arguments_: RunnerArguments): Promise<RunReceipt> {
  const requestedCwd = resolve(arguments_.cwd)
  const cwd = await realpath(requestedCwd)
  const { environment, sandboxRoot } = await createEnvironment(cwd, arguments_.profile)
  const startedAt = performance.now()
  const child = Bun.spawn([...arguments_.argv], {
    cwd,
    detached: process.platform !== "win32",
    env: environment,
    stderr: "pipe",
    stdout: "pipe",
  })
  let completionSettled = false
  const completion = Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then((result) => {
    completionSettled = true
    return result
  })
  try {
    const initial = await settleWithin(completion, arguments_.timeoutMs)
    const timedOut = !initial.settled
    const cleanupError = timedOut
      ? await cleanupProcessTree({
          completionSettled: () => completionSettled,
          pid: child.pid,
          systemRoot: inherited("SystemRoot"),
        }).then(
          () => undefined,
          (error: unknown) => error,
        )
      : undefined
    if (!timedOut && process.platform !== "win32") {
      await cleanupProcessTree({ completionSettled: () => true, pid: child.pid, systemRoot: "" })
    }
    const completed = initial.settled
      ? initial
      : await settleWithin(completion, POST_KILL_COMPLETION_MS)
    if (!completed.settled) {
      if (cleanupError !== undefined) throw cleanupError
      throw new ProcessTreeCleanupError(child.pid)
    }
    if (cleanupError !== undefined) throw cleanupError
    const [exitCode, stdout, stderr] = completed.value
    const output = `${stdout}\n${stderr}`
    const acceptedExit = !timedOut && exitCode === 0 && !collectedZeroTests(arguments_.argv, output)
    return {
      cleanup: { processTree: "complete", sandbox: "complete" },
      durationMs: Math.round(performance.now() - startedAt),
      envProfile: arguments_.profile,
      exitCode: acceptedExit ? 0 : exitCode === 0 ? 1 : exitCode,
      stderr,
      stdout,
      timedOut,
    }
  } finally {
    await rm(sandboxRoot, { force: true, recursive: true })
  }
}

async function main(): Promise<void> {
  // no-excuse-ok: catch — CLI boundary converts all failures into a nonzero process result.
  try {
    const receipt = await run(parseArguments(Bun.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
    process.exitCode = receipt.exitCode
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}

await main()
