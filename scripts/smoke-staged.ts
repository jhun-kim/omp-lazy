import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { sha256File } from "./artifact-hash"

const argumentsSchema = z.union([
  z.tuple([]),
  z.tuple([
    z.literal("--describe"),
    z.literal("--tarball"),
    z
      .string()
      .min(1)
      .refine((path) => path.toLowerCase().endsWith(".tgz"), "tarball must end in .tgz"),
  ]),
])
const candidateReceiptSchema = z.object({
  sha256: z.string().length(64),
  tarball: z.string().min(1),
})

class StagedSmokeError extends Error {
  override readonly name = "StagedSmokeError"
}

async function main(): Promise<void> {
  const parsed = argumentsSchema.parse(Bun.argv.slice(2))
  if (parsed.length > 0) {
    resolve(z.string().parse(parsed[2]))
    process.stdout.write(
      `${JSON.stringify({
        installShape: "ordinary-directory",
        npmInstallProof: false,
        route: "staged-tarball",
      })}\n`,
    )
    return
  }

  const root = resolve(process.cwd())
  const receipt = candidateReceiptSchema.parse(
    JSON.parse(
      await readFile(join(root, ".omo", "evidence", "candidate", "candidate.json"), "utf8"),
    ),
  )
  const tarball = resolve(receipt.tarball)
  if ((await sha256File(tarball)) !== receipt.sha256) {
    throw new StagedSmokeError("candidate tarball hash changed")
  }
  const { TEMP: temp } = process.env
  if (temp === undefined) throw new StagedSmokeError("isolated TEMP is required")
  const sandbox = await mkdtemp(join(temp, "omp-lazy-staged-"))
  try {
    await writeFile(
      join(sandbox, "package.json"),
      `${JSON.stringify({ dependencies: { "omp-lazy": `file:${tarball}` }, private: true })}\n`,
    )
    const install = Bun.spawn(["bun", "install", "--ignore-scripts"], {
      cwd: sandbox,
      env: process.env,
      stderr: "pipe",
      stdout: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      install.exited,
      new Response(install.stdout).text(),
      new Response(install.stderr).text(),
    ])
    if (exitCode !== 0) throw new StagedSmokeError(`staged install failed: ${stdout}\n${stderr}`)
    const installedRoot = join(sandbox, "node_modules", "omp-lazy")
    const installedStat = await lstat(installedRoot)
    if (!installedStat.isDirectory() || installedStat.isSymbolicLink()) {
      throw new StagedSmokeError("staged package is not an ordinary directory")
    }
    const project = join(sandbox, "project")
    await mkdir(join(project, ".omp"), { recursive: true })
    await writeFile(
      join(project, ".omp", "settings.json"),
      `${JSON.stringify({ extensions: [installedRoot] })}\n`,
    )
    const { probeStagedRuntime } = await import("./staged-runtime-probe")
    const runtime = await probeStagedRuntime(installedRoot, project)
    if (runtime.loaderErrors.length > 0)
      throw new StagedSmokeError("staged extension loader failed")
    process.stdout.write(
      `${JSON.stringify({
        ...runtime,
        installShape: "ordinary-directory",
        npmInstallProof: false,
        route: "staged-tarball",
        sha256: receipt.sha256,
      })}\n`,
    )
  } finally {
    await rm(sandbox, { force: true, recursive: true })
  }
}

// no-excuse-ok: catch — staged smoke is a CLI boundary.
try {
  await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
