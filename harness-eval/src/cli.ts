import { access, readFile } from "node:fs/promises"
import { writeSyntheticHarnessBundle } from "./synthetic-bundle"
import { verifyHarnessBundle } from "./verifier"

type CliReceipt =
  | { readonly status: "PASS" }
  | { readonly code: string; readonly status: "BLOCKED" | "FAIL" }

type Flags = ReadonlyMap<string, string | true>

const modes = new Set(["baseline", "deterministic", "live"])
const profiles = "legacy-low,candidate-high,candidate-low"

function parseFlags(argv: readonly string[]): Flags | undefined {
  const flags = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === undefined || !flag.startsWith("--") || flag.includes("=")) return undefined
    if (flags.has(flag)) return undefined
    if (flag === "--all") {
      flags.set(flag, true)
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--") || value.length === 0) return undefined
    flags.set(flag, value)
    index += 1
  }
  return flags
}

function value(flags: Flags, flag: string): string | undefined {
  const candidate = flags.get(flag)
  return typeof candidate === "string" ? candidate : undefined
}

function hasExactKeys(flags: Flags, allowed: readonly string[]): boolean {
  return [...flags.keys()].every((flag) => allowed.includes(flag))
}

function selectorIsValid(flags: Flags): boolean {
  return ["--scenario", "--scenarios", "--all"].filter((flag) => flags.has(flag)).length === 1
}

async function unavailableManifest(path: string): Promise<CliReceipt> {
  try {
    await access(path)
    return { code: "corpus_unavailable", status: "BLOCKED" }
  } catch (error) {
    if (error instanceof Error) return { code: "manifest_unavailable", status: "BLOCKED" }
    return { code: "manifest_unavailable", status: "BLOCKED" }
  }
}

async function verifyBundle(path: string): Promise<CliReceipt> {
  try {
    const input: unknown = JSON.parse(await readFile(path, "utf8"))
    const receipt = verifyHarnessBundle(input)
    return receipt.status === "PASS" ? receipt : { code: receipt.code, status: "FAIL" }
  } catch (error) {
    if (error instanceof SyntaxError) return { code: "malformed_bundle", status: "FAIL" }
    return { code: "bundle_read_error", status: "BLOCKED" }
  }
}

async function run(flags: Flags): Promise<CliReceipt> {
  const mode = value(flags, "--mode")
  const manifest = value(flags, "--manifest")
  const targetCommit = value(flags, "--target-commit")
  if (
    !hasExactKeys(flags, [
      "--mode",
      "--manifest",
      "--scenario",
      "--scenarios",
      "--all",
      "--target-commit",
      "--profiles",
      "--credential-ref",
      "--target-root",
    ]) ||
    mode === undefined ||
    !modes.has(mode) ||
    manifest === undefined ||
    targetCommit === undefined ||
    !selectorIsValid(flags)
  )
    return { code: "malformed_cli", status: "FAIL" }
  if (
    mode === "live" &&
    (value(flags, "--profiles") !== profiles ||
      value(flags, "--credential-ref") !== "ENV:OMP_HARNESS_UPSTREAM_KEY")
  ) {
    return { code: "malformed_cli", status: "FAIL" }
  }
  if (mode !== "live" && (flags.has("--profiles") || flags.has("--credential-ref")))
    return { code: "malformed_cli", status: "FAIL" }
  return unavailableManifest(manifest)
}

async function execute(argv: readonly string[]): Promise<CliReceipt> {
  const [command, ...arguments_] = argv
  const flags = parseFlags(arguments_)
  if (flags === undefined) return { code: "malformed_cli", status: "FAIL" }
  if (command === "run") return run(flags)
  if (command === "verify") {
    const bundle = value(flags, "--bundle")
    if (
      bundle !== undefined &&
      hasExactKeys(flags, ["--bundle"]) &&
      process.env.OMP_HARNESS_DEV === "1"
    )
      return verifyBundle(bundle)
    const manifest = value(flags, "--manifest")
    if (
      manifest === undefined ||
      value(flags, "--target-commit") === undefined ||
      !hasExactKeys(flags, ["--manifest", "--target-commit"])
    )
      return { code: "malformed_cli", status: "FAIL" }
    return unavailableManifest(manifest)
  }
  if (
    command === "evidence" &&
    hasExactKeys(flags, ["--mode"]) &&
    (value(flags, "--mode") === "source" || value(flags, "--mode") === "review")
  )
    return { code: "manifest_unavailable", status: "BLOCKED" }
  if (command === "audit") return { code: "auditor_unavailable", status: "BLOCKED" }
  if (command === "synthetic" && hasExactKeys(flags, ["--output"])) {
    const output = value(flags, "--output")
    if (output === undefined) return { code: "malformed_cli", status: "FAIL" }
    await writeSyntheticHarnessBundle(output)
    return { status: "PASS" }
  }
  return { code: "malformed_cli", status: "FAIL" }
}

async function main(): Promise<void> {
  try {
    const receipt = await execute(Bun.argv.slice(2))
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
    process.exitCode = receipt.status === "PASS" ? 0 : receipt.status === "BLOCKED" ? 2 : 1
  } catch (error) {
    if (error instanceof Error)
      process.stdout.write('{"code":"bundle_read_error","status":"BLOCKED"}\n')
    else process.stdout.write('{"code":"bundle_read_error","status":"BLOCKED"}\n')
    process.exitCode = 2
  }
}

await main()
