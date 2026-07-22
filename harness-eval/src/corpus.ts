import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { SCENARIO_IDS } from "./constants"
import { fixtureFilesForScenario, hashFixtureEntries, readFixtureEntries } from "./fixture-tree-v1"
import { SCENARIOS } from "./scenarios"
import { type Manifest, manifestSchema } from "./schema"

export const corpusRejectionCodes = [
  "duplicate_scenario_id",
  "fixture_containment_violation",
  "fixture_tree_hash_mismatch",
  "manifest_authority_mismatch",
  "manifest_hash_mismatch",
  "manifest_schema_invalid",
  "required_scenario_missing",
] as const

export type CorpusReceipt =
  | { readonly status: "PASS" }
  | { readonly code: (typeof corpusRejectionCodes)[number]; readonly status: "FAIL" }

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function fixtureAuthority(row: Manifest["scenarios"][number]): unknown {
  return {
    ...row,
    fixture: { ...row.fixture, expectedTreeHash: null },
  }
}

function hasDuplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length
}

function rawScenarioIds(input: unknown): readonly string[] | undefined {
  if (input === null || typeof input !== "object" || !("scenarioIds" in input)) return undefined
  const scenarioIds = input.scenarioIds
  return Array.isArray(scenarioIds) && scenarioIds.every((id) => typeof id === "string")
    ? scenarioIds
    : undefined
}

function scenarioAuthorityReceipt(manifest: Manifest): CorpusReceipt | undefined {
  if (hasDuplicate(manifest.scenarioIds) || hasDuplicate(manifest.scenarios.map((row) => row.id))) {
    return { code: "duplicate_scenario_id", status: "FAIL" }
  }
  if (
    SCENARIO_IDS.some(
      (id) =>
        !manifest.scenarioIds.includes(id) || !manifest.scenarios.some((row) => row.id === id),
    )
  ) {
    return { code: "required_scenario_missing", status: "FAIL" }
  }
  if (JSON.stringify(manifest.scenarioIds) !== JSON.stringify(SCENARIO_IDS)) {
    return { code: "manifest_authority_mismatch", status: "FAIL" }
  }
  if (
    manifest.scenarios.some(
      (row, index) => canonicalJson(fixtureAuthority(row)) !== canonicalJson(SCENARIOS[index]),
    )
  ) {
    return { code: "manifest_authority_mismatch", status: "FAIL" }
  }
  return undefined
}

async function hashIsCurrent(manifestPath: string): Promise<boolean> {
  if (basename(manifestPath) !== "manifest.v1.json") return true
  const [manifest, expected] = await Promise.all([
    readFile(manifestPath),
    readFile(join(manifestPath, "..", "manifest.v1.sha256"), "utf8"),
  ])
  return createHash("sha256").update(manifest).digest("hex") === expected.trim()
}

async function fixtureReceipt(manifest: Manifest, syntheticTarget: string): Promise<CorpusReceipt> {
  const names = await readFixtureEntries(syntheticTarget)
  const topLevel = new Set(names.map((entry) => entry.path.split("/")[0]))
  if (topLevel.size !== SCENARIO_IDS.length || SCENARIO_IDS.some((id) => !topLevel.has(id))) {
    return { code: "fixture_containment_violation", status: "FAIL" }
  }
  for (const scenario of manifest.scenarios) {
    const entries = await readFixtureEntries(join(syntheticTarget, scenario.id))
    const authority = SCENARIOS.find((candidate) => candidate.id === scenario.id)
    if (authority === undefined) return { code: "required_scenario_missing", status: "FAIL" }
    const expected = fixtureFilesForScenario(authority)
    const actualPaths = entries.map((entry) => entry.path)
    if (
      JSON.stringify(actualPaths) !== JSON.stringify(expected.map((file) => file.path)) ||
      hashFixtureEntries(entries) !== scenario.fixture.expectedTreeHash
    ) {
      return { code: "fixture_tree_hash_mismatch", status: "FAIL" }
    }
  }
  return { status: "PASS" }
}

export async function validateDeterministicCorpus(
  manifestPath: string,
  syntheticTarget: string,
): Promise<CorpusReceipt> {
  let input: unknown
  try {
    input = JSON.parse(await readFile(manifestPath, "utf8"))
  } catch {
    return { code: "manifest_schema_invalid", status: "FAIL" }
  }
  const parsed = manifestSchema.safeParse(input)
  if (!parsed.success) {
    const scenarioIds = rawScenarioIds(input)
    if (scenarioIds !== undefined) {
      if (hasDuplicate(scenarioIds)) return { code: "duplicate_scenario_id", status: "FAIL" }
      if (SCENARIO_IDS.some((id) => !scenarioIds.includes(id))) {
        return { code: "required_scenario_missing", status: "FAIL" }
      }
    }
    return { code: "manifest_schema_invalid", status: "FAIL" }
  }
  const authority = scenarioAuthorityReceipt(parsed.data)
  if (authority !== undefined) return authority
  try {
    if (!(await hashIsCurrent(manifestPath)))
      return { code: "manifest_hash_mismatch", status: "FAIL" }
    return await fixtureReceipt(parsed.data, syntheticTarget)
  } catch {
    return { code: "fixture_containment_violation", status: "FAIL" }
  }
}
