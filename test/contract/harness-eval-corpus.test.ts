import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { SCENARIO_IDS } from "../../harness-eval/src/constants"
import { manifestSchema } from "../../harness-eval/src/schema"

const manifestPath = join("harness-eval", "manifest.v1.json")
const fixtureRoot = join("harness-eval", "fixtures", "synthetic-target")

type FixtureEntry = {
  readonly bytes: number
  readonly path: string
  readonly sha256: string
}

async function fixtureEntries(root: string): Promise<readonly FixtureEntry[]> {
  const paths: string[] = []
  async function visit(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).toSorted((left, right) =>
      left.name.localeCompare(right.name),
    )
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) paths.push(path)
      else throw new TypeError(`fixture contains a non-regular entry: ${path}`)
    }
  }
  await visit(root)
  return Promise.all(
    paths.map(async (path) => {
      const bytes = await readFile(path)
      return {
        bytes: bytes.byteLength,
        path: relative(root, path).replaceAll("\\", "/"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }
    }),
  )
}

function fixtureTreeHash(entries: readonly FixtureEntry[]): string {
  const canonical = entries
    .toSorted((left, right) => left.path.localeCompare(right.path))
    .map((entry) => `${entry.path}\0${entry.sha256}\0${entry.bytes}\n`)
    .join("")
  return createHash("sha256").update(canonical).digest("hex")
}

describe("frozen harness evaluator corpus", () => {
  it("materializes all 24 ordered fixture trees with independent SHA-256 hashes", async () => {
    // Given the committed deterministic corpus
    const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")))

    // When each declared fixture tree is independently hashed from its files
    const hashes = await Promise.all(
      manifest.scenarios.map(async (scenario) => ({
        id: scenario.id,
        hash: fixtureTreeHash(await fixtureEntries(join(fixtureRoot, scenario.id))),
      })),
    )

    // Then the exact T01 authority order is complete, unique, and hash-bound
    expect([...manifest.scenarioIds]).toEqual([...SCENARIO_IDS])
    expect(new Set(manifest.scenarioIds).size).toBe(SCENARIO_IDS.length)
    expect(manifest.scenarios.map((scenario) => scenario.id)).toEqual([...SCENARIO_IDS])
    expect(new Set(manifest.scenarios.map((scenario) => scenario.id)).size).toBe(
      SCENARIO_IDS.length,
    )
    const expectedHashes = manifest.scenarios.map((scenario) => {
      if (scenario.fixture.expectedTreeHash === null) {
        throw new TypeError(`fixture hash missing for ${scenario.id}`)
      }
      return { id: scenario.id, hash: scenario.fixture.expectedTreeHash }
    })
    expect(hashes).toEqual(expectedHashes)
  })

  it("freezes strict manifest and live-profile input schema hashes", async () => {
    // Given the manifest and non-secret operator-input schema bytes
    const [manifestBytes, manifestHash, schema, schemaHash] = await Promise.all([
      readFile(manifestPath),
      readFile(join("harness-eval", "manifest.v1.sha256"), "utf8"),
      readFile(join("harness-eval", "live-profile-input.schema.v1.json"), "utf8"),
      readFile(join("harness-eval", "live-profile-input.schema.v1.sha256"), "utf8"),
    ])

    // When their external closure hashes and schema restrictions are inspected
    const inputSchema: unknown = JSON.parse(schema)

    // Then hashes match exact bytes and live records require only attested public metadata
    expect(manifestHash.trim()).toBe(createHash("sha256").update(manifestBytes).digest("hex"))
    expect(schemaHash.trim()).toBe(createHash("sha256").update(schema).digest("hex"))
    expect(inputSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        profiles: { minItems: 3, maxItems: 3 },
      },
      required: ["schemaVersion", "profiles"],
    })
    expect(schema).not.toContain("secret")
    expect(schema).not.toContain("apiKey")
  })
})
