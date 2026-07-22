import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { ACTOR_IDS, PROFILE_IDS, SCENARIO_IDS } from "./constants"
import { validateDeterministicCorpus } from "./corpus"
import { fixtureFilesForScenario, fixtureHashes } from "./fixture-tree-v1"
import { SCENARIOS } from "./scenarios"

const baselineTargetCommit = "14b3f36d6fb3ee378b19f4296d4d5a82b0661fbd"
const baselineTargetTree = "6f73e2d3c3e1e10e4b7ce04b596ada1c221dbffb"
const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex")
const text = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

const liveProfileInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  properties: {
    profiles: {
      items: {
        additionalProperties: false,
        properties: {
          effectiveDate: { format: "date", type: "string" },
          inputNanos: { minimum: 0, type: "integer" },
          modelId: { pattern: "^[a-z][a-z0-9._-]{0,63}$", type: "string" },
          modelRevision: { pattern: "^[a-f0-9]{64}$", type: "string" },
          outputNanos: { minimum: 0, type: "integer" },
          profileId: { enum: PROFILE_IDS, type: "string" },
          retrievalDate: { format: "date", type: "string" },
          sourceSha256: { pattern: "^[a-f0-9]{64}$", type: "string" },
          sourceUrl: { format: "uri", pattern: "^https://", type: "string" },
        },
        required: [
          "profileId",
          "modelId",
          "modelRevision",
          "inputNanos",
          "outputNanos",
          "sourceUrl",
          "sourceSha256",
          "retrievalDate",
          "effectiveDate",
        ],
        type: "object",
      },
      maxItems: 3,
      minItems: 3,
      type: "array",
    },
    schemaVersion: { const: 1, type: "integer" },
  },
  required: ["schemaVersion", "profiles"],
  type: "object",
} as const

async function writeNew(path: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes, { flag: "wx" })
}

const failpoints = ["after_fixture_write", "before_publish"] as const
type MaterializeFailpoint = (typeof failpoints)[number]

export type MaterializeOptions = {
  readonly failpoint?: MaterializeFailpoint
  readonly sourceRoot?: string
}

function failpoint(options: MaterializeOptions): MaterializeFailpoint | undefined {
  const candidate = options.failpoint ?? process.env.OMP_HARNESS_MATERIALIZE_FAILPOINT
  return failpoints.find((value) => value === candidate)
}

function interruptAt(
  expected: MaterializeFailpoint,
  configured: MaterializeFailpoint | undefined,
): void {
  if (configured === expected) throw new TypeError(`materialization failpoint: ${expected}`)
}

async function rootInputEntries(
  sourceRoot: string,
): Promise<readonly { readonly path: string; readonly sha256: string }[]> {
  const paths = ["package.json", "bun.lock", "tsconfig.json", "biome.json"] as const
  return Promise.all(
    paths.map(async (path) => ({ path, sha256: sha256(await readFile(join(sourceRoot, path))) })),
  )
}

async function writeMaterializedFiles(root: string, options: MaterializeOptions): Promise<void> {
  const fixtureRoot = join(root, "fixtures", "synthetic-target")
  const hashes = fixtureHashes()
  for (const scenario of SCENARIOS) {
    for (const file of fixtureFilesForScenario(scenario)) {
      await writeNew(join(fixtureRoot, scenario.id, file.path), file.bytes)
    }
    interruptAt("after_fixture_write", failpoint(options))
  }
  const schemaBytes = text(liveProfileInputSchema)
  const manifest = {
    actorMappings: ACTOR_IDS.map((actorId) => ({
      actorId,
      candidateHighRoute: `/actor/${actorId}`,
      candidateLowRoute: `/actor/${actorId}`,
      legacyLowRoute: `/actor/${actorId}`,
    })),
    baselineTargetCommit,
    baselineTargetTree,
    hostExecutableSha256: sha256("omp-17.0.5-deterministic-fixture"),
    hostVersion: "17.0.5",
    liveProfileInputSchemaSha256: sha256(schemaBytes),
    manifestId: "harness-eval-v1",
    modelConfigHash: sha256("deterministic-model-config-v1"),
    priceCatalog: PROFILE_IDS.map((profileId, index) => ({
      currency: "USD",
      effectiveDate: "2026-07-21",
      inputNanos: index + 1,
      modelId: `fixture-${profileId}`,
      modelRevision: sha256(`fixture-${profileId}-revision`),
      outputNanos: index + 2,
      perTokenUnit: "token",
      retrievalDate: "2026-07-21",
      sourceSha256: sha256(`fixture-${profileId}-source`),
      sourceUrl: `https://example.invalid/harness/${profileId}`,
    })),
    scenarios: SCENARIOS.map((scenario) => ({
      ...scenario,
      fixture: { ...scenario.fixture, expectedTreeHash: hashes.get(scenario.id) },
    })),
    scenarioIds: SCENARIO_IDS,
    schemaVersion: 1,
    settingsHash: sha256("deterministic-settings-v1"),
    targetCommit: baselineTargetCommit,
  }
  const manifestBytes = text(manifest)
  const closureInputs = text({
    schemaVersion: 1,
    entries: await rootInputEntries(options.sourceRoot ?? process.cwd()),
  })
  await Promise.all([
    writeNew(join(root, "manifest.v1.json"), manifestBytes),
    writeNew(join(root, "manifest.v1.sha256"), `${sha256(manifestBytes)}\n`),
    writeNew(join(root, "live-profile-input.schema.v1.json"), schemaBytes),
    writeNew(join(root, "live-profile-input.schema.v1.sha256"), `${sha256(schemaBytes)}\n`),
    writeNew(join(root, "closure-inputs.v1.json"), closureInputs),
  ])
}

async function ensureAbsent(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return
    throw error
  }
  throw new TypeError(`materialization destination already exists: ${path}`)
}

async function verifyMaterializedFiles(root: string): Promise<void> {
  const checks = [
    ["manifest.v1.json", "manifest.v1.sha256"],
    ["live-profile-input.schema.v1.json", "live-profile-input.schema.v1.sha256"],
  ] as const
  for (const [payload, sidecar] of checks) {
    const [bytes, expected] = await Promise.all([
      readFile(join(root, payload)),
      readFile(join(root, sidecar), "utf8"),
    ])
    if (sha256(bytes) !== expected.trim())
      throw new TypeError(`invalid materialized hash: ${payload}`)
  }
  const receipt = await validateDeterministicCorpus(
    join(root, "manifest.v1.json"),
    join(root, "fixtures", "synthetic-target"),
  )
  if (receipt.status !== "PASS") throw new TypeError(`invalid materialized corpus: ${receipt.code}`)
}

export async function materializeHarnessEval(
  destination: string,
  options: MaterializeOptions = {},
): Promise<void> {
  await ensureAbsent(destination)
  const temporary = join(dirname(destination), `.${basename(destination)}.tmp-${randomUUID()}`)
  try {
    await mkdir(temporary)
    await writeMaterializedFiles(temporary, options)
    await verifyMaterializedFiles(temporary)
    interruptAt("before_publish", failpoint(options))
    await ensureAbsent(destination)
    await rename(temporary, destination)
  } catch (error) {
    await rm(temporary, { force: true, recursive: true })
    throw error
  }
}

if (Bun.argv.slice(2).length !== 0) throw new TypeError("materialize accepts no arguments")
await materializeHarnessEval(join(process.cwd(), "harness-eval"))
