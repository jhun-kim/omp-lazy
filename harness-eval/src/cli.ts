import { readFile } from "node:fs/promises"
import { writeSyntheticHarnessBundle } from "./synthetic-bundle"
import { verifyHarnessBundle } from "./verifier"

type CliReceipt =
  | { readonly status: "PASS" }
  | {
      readonly code:
        | "bundle_read_error"
        | "corpus_unavailable"
        | "malformed_bundle"
        | "malformed_cli"
      readonly status: "BLOCKED" | "FAIL"
    }

function malformed(): CliReceipt {
  return { code: "malformed_cli", status: "FAIL" }
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

async function execute(argv: readonly string[]): Promise<CliReceipt> {
  const [command, ...arguments_] = argv
  if (command === "verify" && arguments_.length === 2 && arguments_[0] === "--bundle") {
    const bundle = arguments_[1]
    return bundle === undefined ? malformed() : verifyBundle(bundle)
  }
  if (command === "synthetic" && arguments_.length === 2 && arguments_[0] === "--output") {
    const output = arguments_[1]
    if (output === undefined) return malformed()
    await writeSyntheticHarnessBundle(output)
    return { status: "PASS" }
  }
  if (
    (command === "run" || command === "evidence") &&
    arguments_.length === 2 &&
    arguments_[0] === "--mode"
  ) {
    return { code: "corpus_unavailable", status: "BLOCKED" }
  }
  return malformed()
}

async function main(): Promise<void> {
  // no-excuse-ok: catch — CLI boundary emits one structured result for every failure.
  try {
    const receipt = await execute(Bun.argv.slice(2))
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
    process.exitCode = receipt.status === "PASS" ? 0 : receipt.status === "BLOCKED" ? 2 : 1
  } catch (_error) {
    process.stdout.write(`${JSON.stringify({ code: "bundle_read_error", status: "BLOCKED" })}\n`)
    process.exitCode = 2
  }
}

await main()
