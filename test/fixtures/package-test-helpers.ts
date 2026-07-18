import { setDefaultTimeout } from "bun:test"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

export type CommandResult = {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

export const repositoryRoot = join(import.meta.dir, "..", "..")

setDefaultTimeout(30_000)

export function run(
  command: readonly string[],
  cwd = repositoryRoot,
  environment: Readonly<Record<string, string>> = {},
): CommandResult {
  const result = Bun.spawnSync({
    cmd: [...command],
    cwd,
    env: { ...process.env, ...environment },
    stderr: "pipe",
    stdout: "pipe",
  })
  const decoder = new TextDecoder()
  return {
    exitCode: result.exitCode,
    stderr: decoder.decode(result.stderr),
    stdout: decoder.decode(result.stdout),
  }
}

export async function copyCandidate(prefix: string): Promise<string> {
  const candidate = await mkdtemp(join(repositoryRoot, `.todo3-${prefix}-`))
  await Promise.all(
    ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "package.json", "third_party"].map((entry) =>
      cp(join(repositoryRoot, entry), join(candidate, entry), { recursive: true }),
    ),
  )
  await mkdir(join(candidate, "scripts"), { recursive: true })
  await cp(
    join(repositoryRoot, "scripts", "assert-skill-sync.ts"),
    join(candidate, "scripts", "assert-skill-sync.ts"),
  )
  return candidate
}

export async function removeCandidate(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true })
}

export async function writeJson(path: string, value: object): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}
