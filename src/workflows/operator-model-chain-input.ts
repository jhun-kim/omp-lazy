/**
 * Operator model-chain override input loader.
 *
 * Reads an OPTIONAL `.omo/inputs/model-chain.v1.json` validated against the committed
 * frozen schema plus its SHA-256 sidecar. Feeds `agentModelOverrides` into
 * model-role-resolution. Absent file means alias-only chains and no error.
 * An invalid file is a typed refusal (`invalid_resolution_input`) with nothing partially applied.
 *
 * Constraints:
 * - No network read of any kind
 * - Refuses any path outside `.omo/inputs`
 * - Never writes operator model ids into evidence or logs
 * - No new runtime dependency
 */
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { z } from "zod"
import { isDisplayPathContained } from "../state/paths"

/** The committed schema path relative to repository root. */
const SCHEMA_RELATIVE_PATH = "schemas/model-chain-input.schema.v1.json"
/** The committed SHA-256 sidecar path relative to repository root. */
const SCHEMA_SHA256_RELATIVE_PATH = "schemas/model-chain-input.schema.v1.sha256"
/** The operator input file path relative to repository root. */
export const MODEL_CHAIN_INPUT_RELATIVE_PATH = ".omo/inputs/model-chain.v1.json"

/** Valid agent names that can appear in overrides. */
const VALID_AGENT_NAMES = new Set([
  "omp-lazy-worker-low",
  "omp-lazy-worker-medium",
  "omp-lazy-worker-high",
  "omp-lazy-explorer",
  "omp-lazy-librarian",
  "omp-lazy-researcher",
  "omp-lazy-planner",
  "omp-lazy-metis",
  "omp-lazy-momus",
  "omp-lazy-qa",
  "omp-lazy-reviewer",
])

/** Allowed model chain pattern (role aliases or provider/model). */
const CHAIN_ENTRY_PATTERN = /^@(smol|task|slow)$|^[a-z][a-z0-9._-]{0,63}\/[a-z][a-z0-9._-]{0,63}$/

/** Zod schema for runtime validation of the input file content. */
const modelChainInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    overrides: z.record(z.string(), z.array(z.string().regex(CHAIN_ENTRY_PATTERN)).min(1).max(8)),
  })
  .strict()
  .refine((data) => Object.keys(data.overrides).every((key) => VALID_AGENT_NAMES.has(key)), {
    message: "override key is not a valid agent name",
  })

export type ModelChainInput = {
  readonly schemaVersion: 1
  readonly overrides: Record<string, readonly string[]>
}

export type ModelChainInputRefusalCode =
  | "invalid_resolution_input"
  | "schema_integrity_mismatch"
  | "path_outside_inputs"

export type ModelChainInputReceipt =
  | { readonly status: "PASS"; readonly value: ModelChainInput }
  | { readonly status: "ABSENT" }
  | { readonly status: "BLOCKED"; readonly code: ModelChainInputRefusalCode }

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * Validates that the committed schema file's SHA-256 matches its sidecar.
 * Returns true if valid, false if the schema integrity check fails.
 */
async function validateSchemaIntegrity(repositoryRoot: string): Promise<boolean> {
  try {
    const schemaPath = join(repositoryRoot, SCHEMA_RELATIVE_PATH)
    const sidecarPath = join(repositoryRoot, SCHEMA_SHA256_RELATIVE_PATH)

    const [schemaBytes, sidecarContent] = await Promise.all([
      readFile(schemaPath),
      readFile(sidecarPath, "utf8"),
    ])

    const expectedHash = sidecarContent.trim()
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) return false

    const actualHash = sha256Hex(schemaBytes)
    return actualHash === expectedHash
  } catch {
    return false
  }
}

/**
 * Validates that the input file path is contained within `.omo/inputs`.
 * Refuses absolute paths and anything outside the allowed root.
 */
function validateInputPath(repositoryRoot: string, inputPath: string): boolean {
  if (isAbsolute(inputPath)) return false
  const resolved = resolve(repositoryRoot, inputPath)
  const allowedRoot = join(repositoryRoot, ".omo", "inputs")
  return isDisplayPathContained(allowedRoot, resolved)
}

/**
 * Reads the optional operator model-chain override file.
 *
 * @param repositoryRoot - Absolute path to the repository root.
 * @param inputRelativePath - Relative path to the input file (defaults to MODEL_CHAIN_INPUT_RELATIVE_PATH).
 *                            Must be within `.omo/inputs/`.
 * @returns A receipt indicating success, absence, or typed refusal.
 */
export async function readModelChainInput(
  repositoryRoot: string,
  inputRelativePath: string = MODEL_CHAIN_INPUT_RELATIVE_PATH,
): Promise<ModelChainInputReceipt> {
  // Containment check: refuse any path outside .omo/inputs
  if (!validateInputPath(repositoryRoot, inputRelativePath)) {
    return { status: "BLOCKED", code: "path_outside_inputs" }
  }

  // Schema integrity: validate that the committed schema sha256 matches its sidecar
  const schemaValid = await validateSchemaIntegrity(repositoryRoot)
  if (!schemaValid) {
    return { status: "BLOCKED", code: "schema_integrity_mismatch" }
  }

  // Read the input file (absent = ok)
  const inputPath = resolve(repositoryRoot, inputRelativePath)
  let rawContent: string
  try {
    rawContent = await readFile(inputPath, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { status: "ABSENT" }
    }
    // Permission or I/O errors are refusals, not crashes
    return { status: "BLOCKED", code: "invalid_resolution_input" }
  }

  // Parse JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(rawContent)
  } catch {
    return { status: "BLOCKED", code: "invalid_resolution_input" }
  }

  // Validate against schema
  const result = modelChainInputSchema.safeParse(parsed)
  if (!result.success) {
    return { status: "BLOCKED", code: "invalid_resolution_input" }
  }

  return { status: "PASS", value: result.data }
}

/**
 * Converts a validated ModelChainInput into the agentModelOverrides format
 * expected by resolveWorkerModelChain/resolveWorkerModelRole.
 *
 * Returns an empty record if the input is absent (alias-only behavior).
 * Returns null if the input is blocked (typed refusal, nothing applied).
 */
export function toAgentModelOverrides(receipt: ModelChainInputReceipt): {
  readonly overrides: Record<string, readonly string[]>
  readonly source: "user_override"
} | null {
  if (receipt.status === "ABSENT") return null
  if (receipt.status === "BLOCKED") return null
  return { overrides: receipt.value.overrides, source: "user_override" }
}
