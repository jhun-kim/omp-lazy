import { lstat, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { z } from "zod"

const argumentsSchema = z.union([
  z.tuple([]),
  z.tuple([z.literal("--describe"), z.literal("--candidate"), z.string().min(1)]),
])
const linkSchema = z
  .object({ enabled: z.boolean(), name: z.string(), path: z.string() })
  .passthrough()
const listSchema = z
  .object({ npm: z.array(z.object({ name: z.string() }).passthrough()) })
  .passthrough()

type ProcessReceipt = {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

class LinkSmokeError extends Error {
  override readonly name = "LinkSmokeError"
}

async function run(command: readonly string[]): Promise<ProcessReceipt> {
  const child = Bun.spawn([...command], { env: process.env, stderr: "pipe", stdout: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stderr, stdout }
}

function hasUnfixedDoctorError(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUnfixedDoctorError)
  if (typeof value !== "object" || value === null) return false
  if (
    "status" in value &&
    value.status === "error" &&
    (!("fixed" in value) || value.fixed !== true)
  ) {
    return true
  }
  return Object.values(value).some(hasUnfixedDoctorError)
}

function assertContained(parent: string, child: string): void {
  const fromParent = relative(parent, child)
  if (fromParent.startsWith("..") || isAbsolute(fromParent)) {
    throw new LinkSmokeError(`resolved mutable root escaped sandbox: ${child}`)
  }
}

async function main(): Promise<void> {
  const parsed = argumentsSchema.parse(Bun.argv.slice(2))
  const candidate = await realpath(resolve(parsed.length === 0 ? process.cwd() : parsed[2]))
  if (parsed.length > 0) {
    process.stdout.write(
      `${JSON.stringify({
        npmInstallProof: false,
        proof: "symlink-required",
        route: "local-link",
      })}\n`,
    )
    return
  }

  const { HOME: homeValue, USERPROFILE: profileValue } = process.env
  if (homeValue === undefined || profileValue === undefined) {
    throw new LinkSmokeError("isolated HOME and USERPROFILE are required")
  }
  const home = await realpath(homeValue)
  const profile = await realpath(profileValue)
  assertContained(resolve(process.cwd()), home)
  assertContained(resolve(process.cwd()), profile)
  const omp = "C:\\Users\\user\\AppData\\Local\\omp\\omp.exe"
  const link = await run([omp, "plugin", "link", candidate, "--json"])
  if (link.exitCode !== 0) throw new LinkSmokeError(`OMP link failed: ${link.stderr}`)
  const linked = linkSchema.parse(JSON.parse(link.stdout))
  if (!linked.enabled || linked.name !== "omp-lazy")
    throw new LinkSmokeError("linked package is not enabled")

  const list = await run([omp, "plugin", "list", "--json"])
  if (list.exitCode !== 0) throw new LinkSmokeError(`OMP list failed: ${list.stderr}`)
  const listed = listSchema.parse(JSON.parse(list.stdout))
  if (!listed.npm.some((plugin) => plugin.name === "omp-lazy")) {
    throw new LinkSmokeError("linked package is missing from OMP list")
  }
  const doctor = await run([omp, "plugin", "doctor", "--json"])
  if (doctor.exitCode !== 0 || hasUnfixedDoctorError(JSON.parse(doctor.stdout))) {
    throw new LinkSmokeError("OMP doctor reported an unfixed error")
  }

  const matches: string[] = []
  for await (const path of new Bun.Glob("**/node_modules/omp-lazy").scan({
    cwd: home,
    onlyFiles: false,
  })) {
    matches.push(join(home, path))
  }
  if (matches.length !== 1)
    throw new LinkSmokeError(`expected one linked path, found ${matches.length}`)
  const linkedRoot = matches[0]
  if (linkedRoot === undefined) throw new LinkSmokeError("linked path disappeared")
  const stat = await lstat(linkedRoot)
  if (!stat.isSymbolicLink() || (await realpath(linkedRoot)) !== candidate) {
    throw new LinkSmokeError("linked path is not an exact symlink to the candidate")
  }

  const loader = await run([
    "bun",
    join(candidate, "scripts", "probe-loader.ts"),
    "--extension",
    join(linkedRoot, "src", "index.ts"),
    "--cwd",
    candidate,
  ])
  if (loader.exitCode !== 0) throw new LinkSmokeError("linked public loader probe failed")
  const discovery = await run([
    "bun",
    join(candidate, "scripts", "probe-discovery.ts"),
    "--cwd",
    candidate,
  ])
  if (discovery.exitCode !== 0) throw new LinkSmokeError("linked public discovery probe failed")
  process.stdout.write(
    `${JSON.stringify({
      doctor: JSON.parse(doctor.stdout),
      link: linked,
      linkTarget: candidate,
      list: listed,
      loader: JSON.parse(loader.stdout),
      discovery: JSON.parse(discovery.stdout),
      npmInstallProof: false,
      route: "local-link",
    })}\n`,
  )
}

// no-excuse-ok: catch — link smoke is a CLI boundary.
try {
  await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
