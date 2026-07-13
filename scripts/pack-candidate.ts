import { chmod, mkdir, realpath, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { sha256File } from "./artifact-hash"
import { inspectCandidate } from "./package-guards"

const argumentsSchema = z.union([
  z.tuple([]),
  z.tuple([z.literal("--candidate"), z.string().min(1), z.literal("--mode"), z.literal("inspect")]),
  z.tuple([
    z.literal("--candidate"),
    z.string().min(1),
    z.literal("--mode"),
    z.literal("build"),
    z.literal("--destination"),
    z.string().min(1),
  ]),
])

class PackageBuildError extends Error {
  override readonly name = "PackageBuildError"
}

function packedAssets(output: string): readonly string[] {
  return output
    .split(/\r?\n/)
    .map((line) => /^packed\s+\S+\s+(.+)$/.exec(line)?.[1]?.replaceAll("\\", "/"))
    .filter((path): path is string => path !== undefined)
}

async function main(): Promise<void> {
  const parsed = argumentsSchema.parse(Bun.argv.slice(2))
  const isDefault = parsed.length === 0
  const candidate = await realpath(resolve(isDefault ? process.cwd() : parsed[1]))
  const mode = isDefault ? "build" : parsed[3]
  const destination =
    mode === "build"
      ? resolve(
          isDefault
            ? join(candidate, ".omo", "evidence", "candidate")
            : z.string().parse(parsed[5]),
        )
      : undefined
  if (destination !== undefined) await mkdir(destination, { recursive: true })

  const pack = Bun.spawn(
    destination === undefined
      ? ["bun", "pm", "pack", "--dry-run"]
      : ["bun", "pm", "pack", "--destination", destination],
    { cwd: candidate, stderr: "pipe", stdout: "pipe" },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    pack.exited,
    new Response(pack.stdout).text(),
    new Response(pack.stderr).text(),
  ])
  if (exitCode !== 0) throw new PackageBuildError(`bun pack failed (${exitCode}): ${stderr}`)

  const assets = packedAssets(`${stdout}\n${stderr}`)
  const inspection = await inspectCandidate(candidate, assets)
  const tarballName = /([^\s]+\.tgz)/.exec(`${stdout}\n${stderr}`)?.[1]
  const tarball =
    destination === undefined || tarballName === undefined
      ? null
      : resolve(destination, tarballName)
  const sha256 = tarball === null ? null : await sha256File(tarball)
  const receipt = { ...inspection, mode, sha256, tarball }
  if (tarball !== null && destination !== undefined) {
    await writeFile(join(destination, "candidate.json"), `${JSON.stringify(receipt, null, 2)}\n`)
    await chmod(tarball, 0o444)
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
}

// no-excuse-ok: catch — candidate inspection is a CLI boundary.
try {
  await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
