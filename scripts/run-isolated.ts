import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { z } from "zod"

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
  readonly argv: readonly string[]
  readonly cleanup: CleanupReceipt
  readonly cwd: string
  readonly durationMs: number
  readonly envProfile: z.infer<typeof profileSchema>
  readonly exitCode: number
  readonly sandboxRoot: string
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

async function createEnvironment(cwd: string): Promise<{
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
      OMP_LAZY_HOST_PROFILE: hostProfile,
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

async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    const killer = Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], {
      stderr: "ignore",
      stdout: "ignore",
    })
    await killer.exited
    return
  }
  process.kill(-pid, "SIGKILL")
}

function collectedZeroTests(argv: readonly string[], output: string): boolean {
  if (argv[0] !== "bun" || argv[1] !== "test") return false
  return /\b0 pass\b|\b0 tests?\b|No tests found/i.test(output)
}

async function run(arguments_: RunnerArguments): Promise<RunReceipt> {
  const requestedCwd = resolve(arguments_.cwd)
  const cwd = await realpath(requestedCwd)
  const { environment, sandboxRoot } = await createEnvironment(cwd)
  const startedAt = performance.now()
  let processTree: "complete" = "complete"
  let timedOut = false

  const child = Bun.spawn([...arguments_.argv], {
    cwd,
    env: environment,
    stderr: "pipe",
    stdout: "pipe",
  })
  const timeout = setTimeout(() => {
    timedOut = true
    void killProcessTree(child.pid)
  }, arguments_.timeoutMs)
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  clearTimeout(timeout)
  if (timedOut) {
    await killProcessTree(child.pid)
    processTree = "complete"
  }
  await rm(sandboxRoot, { force: true, recursive: true })

  const output = `${stdout}\n${stderr}`
  const acceptedExit = !timedOut && exitCode === 0 && !collectedZeroTests(arguments_.argv, output)
  return {
    argv: arguments_.argv,
    cleanup: { processTree, sandbox: "complete" },
    cwd,
    durationMs: Math.round(performance.now() - startedAt),
    envProfile: arguments_.profile,
    exitCode: acceptedExit ? 0 : exitCode === 0 ? 1 : exitCode,
    sandboxRoot,
    stderr,
    stdout,
    timedOut,
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
