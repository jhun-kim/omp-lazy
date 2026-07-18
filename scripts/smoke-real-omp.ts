import { mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import {
  assertPinnedOmpExecutable,
  expectedOmpVersion,
  parseOmpExecutableOption,
} from "./omp-executable"
import { profileFingerprint } from "./profile-fingerprint"

const argumentsSchema = z.union([
  z.tuple([]),
  z.tuple([z.literal("--omp-exe"), z.string().min(1)]),
  z.tuple([z.literal("--describe")]),
  z.tuple([z.literal("--describe"), z.literal("--omp-exe"), z.string().min(1)]),
])

type ProcessReceipt = {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

class DogfoodSmokeError extends Error {
  override readonly name = "DogfoodSmokeError"
}

async function run(
  command: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<ProcessReceipt> {
  const child = Bun.spawn([...command], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stderr: "pipe",
    stdout: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stderr, stdout }
}

function describe(ompExecutable: string | undefined): void {
  process.stdout.write(
    `${JSON.stringify({
      downloadProof: "NOT_RUN",
      npmInstallProof: false,
      ...(ompExecutable === undefined ? {} : { ompExecutable }),
      route: "pinned-real-omp",
      version: expectedOmpVersion,
    })}\n`,
  )
}

async function main(): Promise<void> {
  const parsed = argumentsSchema.parse(Bun.argv.slice(2))
  if (parsed[0] === "--describe") {
    describe(parsed[1] === "--omp-exe" ? parsed[2] : undefined)
    return
  }

  const option = parseOmpExecutableOption(parsed)
  const omp = await assertPinnedOmpExecutable(option.ompPath)
  const { TEMP: tempRoot, OMP_LAZY_HOST_PROFILE: hostProfile } = process.env
  if (tempRoot === undefined || hostProfile === undefined) {
    throw new DogfoodSmokeError("isolated TEMP and host profile are required")
  }
  const realProfile = join(hostProfile, ".omp")
  const realProfileBefore = await profileFingerprint(realProfile)
  const sandbox = join(tempRoot, `omp-lazy-dogfood-${crypto.randomUUID()}`)
  const profile = join(sandbox, "profile")
  const temp = join(sandbox, "temp")
  await Promise.all([mkdir(profile, { recursive: true }), mkdir(temp, { recursive: true })])
  const cleanup: "complete" = "complete"
  let receipt:
    | { readonly inventory: unknown; readonly link: unknown; readonly preflight: unknown }
    | undefined
  try {
    const environment = {
      HOME: profile,
      PI_CODING_AGENT_DIR: join(profile, ".omp", "agent"),
      TEMP: temp,
      TMP: temp,
      USERPROFILE: profile,
    }
    const preflight = await run(
      ["bun", "scripts/preflight-real-omp.ts", "--omp-exe", omp.path, "--diagnostic-provider-only"],
      environment,
    )
    if (preflight.exitCode !== 0)
      throw new DogfoodSmokeError(`preflight failed: ${preflight.stderr}`)
    const link = await run(
      ["bun", "scripts/smoke-link-windows.ts", "--omp-exe", omp.path],
      environment,
    )
    if (link.exitCode !== 0) throw new DogfoodSmokeError(`link failed: ${link.stderr}`)
    const { assertExactProductRuntime, loadRuntimeInventoryFromManifest } = await import(
      "./product-runtime-contract"
    )
    const runtime = await assertExactProductRuntime(
      await loadRuntimeInventoryFromManifest(resolve("package.json")),
    )
    receipt = {
      inventory: runtime.inventory,
      link: JSON.parse(link.stdout),
      preflight: JSON.parse(preflight.stdout),
    }
  } finally {
    await rm(sandbox, { force: true, recursive: true })
  }
  if (receipt === undefined) throw new DogfoodSmokeError("dogfood receipt was not produced")
  const realProfileAfter = await profileFingerprint(realProfile)
  if (realProfileAfter !== realProfileBefore) {
    throw new DogfoodSmokeError("real OMP profile fingerprint changed during dogfood")
  }
  process.stdout.write(
    `${JSON.stringify({
      cleanup: { profile: cleanup, sandbox: cleanup },
      inventory: receipt.inventory,
      link: receipt.link,
      omp,
      preflight: receipt.preflight,
      profileFingerprint: {
        after: realProfileAfter,
        before: realProfileBefore,
        path: realProfile,
        unchanged: true,
      },
      route: "pinned-real-omp",
    })}\n`,
  )
}

// no-excuse-ok: catch — dogfood smoke is a CLI boundary.
try {
  await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
