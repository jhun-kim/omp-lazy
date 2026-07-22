import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { SCENARIO_IDS, type ScenarioId } from "./constants"
import { manifestSchema } from "./schema"

const commitSchema = z.string().regex(/^[a-f0-9]{40}$/)
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const canonicalManifestPath = join("harness-eval", "manifest.v1.json")
export const BASELINE_RECEIPT_PATH = ".omo/evidence/harness-redesign/T03/red-baseline.json"
export const baselineScenarioIds = [...SCENARIO_IDS] as const satisfies readonly ScenarioId[]

export const baselineRows = [
  ["plan.clear", "activation_only"],
  ["plan.owner-decision", "activation_only"],
  ["start-work.complete", "activation_only"],
  ["start-work.stale-plan", "activation_only"],
  ["ulw-loop.complete", "activation_only"],
  ["ulw-loop.repeat-failure", "activation_only"],
  ["ultrawork.fast", "activation_only"],
  ["ultrawork.security", "activation_only"],
  ["teammode.parallel", "grammar_rejected"],
  ["teammode.overlap", "grammar_rejected"],
  ["research.single-wave", "activation_only"],
  ["research.injection", "activation_only"],
  ["doctor.shallow", "activation_only"],
  ["doctor.deep-unavailable", "activation_only"],
  ["report.local", "activation_only"],
  ["report.external-write", "activation_only"],
  ["contribute.dry-run", "activation_only"],
  ["contribute.non-dry", "grammar_rejected"],
  ["cross.activation-injection", "public_surface_unavailable"],
  ["cross.replay-cas", "public_surface_unavailable"],
  ["cross.stale-owner-head", "public_surface_unavailable"],
  ["cross.no-progress", "public_surface_unavailable"],
  ["cross.retry-isolation", "public_surface_unavailable"],
  ["cross.legacy-migration", "public_surface_unavailable"],
].map(([scenarioId, oracleCode]) => ({ scenarioId, oracleCode })) as readonly {
  readonly oracleCode: "activation_only" | "grammar_rejected" | "public_surface_unavailable"
  readonly scenarioId: ScenarioId
}[]

const baselineRowSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      oracleCode: z.enum(["activation_only", "grammar_rejected"]),
      outcome: z.literal("expected_failure_observed"),
      scenarioId: z.enum(SCENARIO_IDS),
    })
    .strict(),
  z
    .object({
      oracleCode: z.literal("public_surface_unavailable"),
      outcome: z.literal("NOT_COMPARABLE"),
      scenarioId: z.enum(SCENARIO_IDS),
    })
    .strict(),
])
export const baselineReceiptSchema = z
  .object({
    baseline: z.object({ targetCommit: commitSchema, targetTree: commitSchema }).strict(),
    cleanup: z
      .object({
        profile: z.literal("not_applicable"),
        temporary: z.literal("complete"),
        worktree: z.literal("complete"),
      })
      .strict(),
    evaluator: z
      .object({
        closureCommit: commitSchema,
        closureTree: commitSchema,
        lockSha256: sha256Schema,
        manifestSha256: sha256Schema,
      })
      .strict(),
    rows: z.array(baselineRowSchema).length(baselineScenarioIds.length).readonly(),
    schemaVersion: z.literal(1),
  })
  .strict()

export type BaselineReceipt = z.infer<typeof baselineReceiptSchema>
export type BaselineReceiptCheck =
  | { readonly status: "PASS" }
  | {
      readonly code: "baseline_commit_mismatch" | "baseline_receipt_invalid"
      readonly status: "FAIL"
    }
export type BaselineManifest = z.infer<typeof manifestSchema>

export function parseBaselineFlags(
  argv: readonly string[],
): { readonly manifestPath: string } | undefined {
  const flags = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === undefined || !flag.startsWith("--") || flag.includes("=") || flags.has(flag))
      return undefined
    if (flag === "--target-commit-from-manifest" || flag === "--assert-legacy-defects") {
      flags.set(flag, true)
      continue
    }
    const value = argv[index + 1]
    if (
      value === undefined ||
      value.startsWith("--") ||
      (flag === "--scenarios" && value !== "legacy-eligible") ||
      (flag === "--manifest" && value !== canonicalManifestPath) ||
      (flag !== "--scenarios" && flag !== "--manifest")
    )
      return undefined
    flags.set(flag, value)
    index += 1
  }
  return flags.get("--target-commit-from-manifest") === true &&
    flags.get("--assert-legacy-defects") === true &&
    flags.get("--scenarios") === "legacy-eligible" &&
    flags.size === 3 + Number(flags.has("--manifest"))
    ? { manifestPath: canonicalManifestPath }
    : undefined
}

export function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}
export async function readBaselineManifest(
  path: string,
): Promise<{ readonly bytes: Uint8Array; readonly manifest: BaselineManifest }> {
  const bytes = await readFile(path)
  return { bytes, manifest: manifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes))) }
}

export async function readClosureBinding(manifestPath: string): Promise<{
  readonly closureCommit: string
  readonly closureTreeHash: string
}> {
  return z
    .object({ closureCommit: commitSchema, closureTreeHash: commitSchema })
    .passthrough()
    .parse(
      JSON.parse(
        await readFile(join(dirname(dirname(manifestPath)), "harness-eval.lock.json"), "utf8"),
      ),
    )
}

function validRows(rows: BaselineReceipt["rows"]): boolean {
  return (
    rows.length === baselineRows.length &&
    rows.every(
      (row, index) =>
        row.scenarioId === baselineRows[index]?.scenarioId &&
        row.oracleCode === baselineRows[index]?.oracleCode,
    )
  )
}

export async function verifyBaselineReceipt(options: {
  readonly manifestPath: string
  readonly receiptPath: string
  readonly targetCommit?: string
}): Promise<BaselineReceiptCheck> {
  try {
    const [{ bytes, manifest }, closure, contents] = await Promise.all([
      readBaselineManifest(options.manifestPath),
      readClosureBinding(options.manifestPath),
      readFile(options.receiptPath, "utf8"),
    ])
    const receipt = baselineReceiptSchema.safeParse(JSON.parse(contents))
    if (
      !receipt.success ||
      !validRows(receipt.data.rows) ||
      /(?:[A-Za-z]:\\|\/Users\/|\/home\/|sk-|api[_-]?key|secret)/iu.test(
        JSON.stringify(receipt.data),
      )
    )
      return { code: "baseline_receipt_invalid", status: "FAIL" }
    return receipt.data.baseline.targetCommit !== manifest.baselineTargetCommit ||
      receipt.data.baseline.targetTree !== manifest.baselineTargetTree ||
      receipt.data.evaluator.closureCommit !== closure.closureCommit ||
      receipt.data.evaluator.closureTree !== closure.closureTreeHash ||
      receipt.data.evaluator.manifestSha256 !== digest(bytes) ||
      (options.targetCommit !== undefined && options.targetCommit !== manifest.baselineTargetCommit)
      ? { code: "baseline_commit_mismatch", status: "FAIL" }
      : { status: "PASS" }
  } catch {
    return { code: "baseline_receipt_invalid", status: "FAIL" }
  }
}
