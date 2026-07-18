import { cp, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { z } from "zod"
import { readCandidateReceipt } from "./candidate-receipt"
import { verifyInstalledPackage } from "./staged-source-verification"

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
        publicRegistry: "NOT_RUN",
        route: "staged-tarball",
      })}\n`,
    )
    return
  }

  const root = await realpath(resolve(process.cwd()))
  const receipt = await readCandidateReceipt(root)
  const tarball = resolve(receipt.tarball)
  const { TEMP: temp } = process.env
  if (temp === undefined) throw new StagedSmokeError("isolated TEMP is required")
  const sandbox = await mkdtemp(join(temp, "omp-lazy-staged-"))
  let stagedReceipt: object | undefined
  try {
    const localZod = resolve(dirname(import.meta.dir), "node_modules", "zod")
    const workspaceZod = join(sandbox, "packages", "zod")
    await mkdir(dirname(workspaceZod), { recursive: true })
    await cp(localZod, workspaceZod, { recursive: true })
    await writeFile(
      join(sandbox, "package.json"),
      `${JSON.stringify({
        dependencies: { "omp-lazy": `file:${tarball}`, zod: "workspace:*" },
        private: true,
        workspaces: ["packages/*"],
      })}\n`,
    )
    const install = Bun.spawn(["bun", "install", "--ignore-scripts", "--linker", "hoisted"], {
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
    await verifyInstalledPackage({
      installedRoot,
      packedAssets: receipt.packedAssets,
      sourceCommit: receipt.sourceCommit,
      sourceRoot: root,
    })
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
    stagedReceipt = {
      ...runtime,
      cleanup: { profile: "complete", sandbox: "complete" },
      installShape: "ordinary-directory",
      npmInstallProof: false,
      packedAssets: receipt.packedAssets,
      route: "staged-tarball",
      sha256: receipt.sha256,
      sourceCommit: receipt.sourceCommit,
      toolchain: receipt.toolchain,
    }
  } finally {
    await rm(sandbox, { force: true, recursive: true })
  }
  if (stagedReceipt === undefined) throw new StagedSmokeError("staged receipt was not produced")
  process.stdout.write(`${JSON.stringify(stagedReceipt)}\n`)
}

// no-excuse-ok: catch — staged smoke is a CLI boundary.
try {
  await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
