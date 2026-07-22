import { afterEach, describe, expect, it } from "bun:test"
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import {
  assertExactProductRuntime,
  expectedProductRuntime,
  loadRuntimeInventoryFromManifest,
} from "../../scripts/product-runtime-contract"
import { repositoryRoot } from "../fixtures/package-test-helpers"
import { removeTestTree } from "../fixtures/remove-test-tree"

const mutableManifestSchema = z
  .object({
    omp: z.object({ extensions: z.array(z.string()) }),
  })
  .passthrough()

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(removeTestTree))
})

async function packageFixture(extensionSources: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omp-lazy-runtime-contract-"))
  temporaryRoots.push(root)
  const extensionEntries = extensionSources.map((_, index) => `./extension-${index}.ts`)
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "omp-lazy", version: "0.1.0", omp: { extensions: extensionEntries } }, null, 2)}\n`,
  )
  await Promise.all(
    extensionSources.map((source, index) => writeFile(join(root, `extension-${index}.ts`), source)),
  )
  return root
}

async function copyProductWithManifestEntry(entry: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omp-lazy-product-contract-"))
  temporaryRoots.push(root)
  await cp(join(repositoryRoot, "package.json"), join(root, "package.json"))
  const manifest = mutableManifestSchema.parse(
    JSON.parse(await Bun.file(join(root, "package.json")).text()),
  )
  manifest.omp.extensions = [entry]
  await writeFile(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  return root
}

describe("product runtime contract", () => {
  it("loads package.json#omp.extensions through the public OMP loader with exact inventory", async () => {
    // Given: the product manifest is the public OMP extension boundary.
    const packageJsonPath = join(repositoryRoot, "package.json")

    // When: the package entry is loaded through OMP's public loader.
    const receipt = await loadRuntimeInventoryFromManifest(packageJsonPath)

    // Then: the loaded product runtime matches the approved exact inventory.
    await assertExactProductRuntime(receipt)
    expect(receipt.version).toBe("0.1.0")
  })

  it("rejects a copied product manifest with a missing entry path", async () => {
    // Given: a product copy whose manifest points at a non-existent extension entry.
    const root = await copyProductWithManifestEntry("./src/missing.ts")

    // When: the package entry is loaded through OMP's public loader.
    const receipt = await loadRuntimeInventoryFromManifest(join(root, "package.json"))

    // Then: the contract fails on the loader error and names the missing path.
    await expect(assertExactProductRuntime(receipt)).rejects.toThrow(
      "loader errors inventory mismatch",
    )
    expect(JSON.stringify(receipt.inventory.errors)).toContain("missing.ts")
  })

  it("rejects duplicate command registration", async () => {
    // Given: a malformed fixture extension registers one approved command twice.
    const duplicateCommand = expectedProductRuntime.commandNames[0]
    if (duplicateCommand === undefined) throw new Error("expected command inventory is empty")
    const root = await packageFixture([
      `
      export default function fixture(api) {
        api.registerCommand("${duplicateCommand}", { handler: async () => {} })
      }
    `,
      `
      export default function fixture(api) {
        api.registerCommand("${duplicateCommand}", { handler: async () => {} })
      }
    `,
    ])

    // When: the fixture is loaded through OMP's public loader.
    const receipt = await loadRuntimeInventoryFromManifest(join(root, "package.json"))

    // Then: duplicate runtime ownership is rejected by name.
    await expect(assertExactProductRuntime(receipt)).rejects.toThrow(
      `duplicate command registration: ${duplicateCommand}`,
    )
  })

  it("rejects exact unexpected tool and agent items in a copied plugin", async () => {
    // Given: a copied plugin fixture registers a tool and agent outside the approved inventory.
    const root = await packageFixture([
      `
      export default function fixture(api) {
        api.registerTool({
          name: "unauthorized_tool",
          description: "not approved",
          parameters: { parse: (value) => value },
          execute: async () => ({ content: [{ type: "text", text: "bad" }] }),
        })
      }
    `,
    ])
    await mkdir(join(root, "agents"), { recursive: true })
    await writeFile(join(root, "agents", "unexpected-agent.md"), agentMarkdown("unexpected-agent"))

    // When: the fixture is loaded through OMP's public loader.
    const receipt = await loadRuntimeInventoryFromManifest(join(root, "package.json"))

    // Then: exact comparison names the unexpected runtime item.
    await expect(assertExactProductRuntime(receipt)).rejects.toThrow(
      'tools inventory mismatch: missing ["omp_lazy_accept_worker_result"], unexpected ["unauthorized_tool"]',
    )
    expect(receipt.inventory.toolNames).toEqual(["unauthorized_tool"])
    expect(receipt.inventory.agentNames).toEqual(["unexpected-agent"])
  })

  it("rejects a loader error before comparing runtime inventory", async () => {
    // Given: a malformed fixture extension cannot be imported.
    const root = await packageFixture(["export default function broken( {\n"])

    // When: the fixture is loaded through OMP's public loader.
    const receipt = await loadRuntimeInventoryFromManifest(join(root, "package.json"))

    // Then: loader errors fail the contract explicitly.
    await expect(assertExactProductRuntime(receipt)).rejects.toThrow(
      "loader errors inventory mismatch",
    )
    expect(JSON.stringify(receipt.inventory.errors)).toContain("Expected identifier")
  })
})

function agentMarkdown(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} contract fixture\nblocking: false\n---\n\nReturn the declared fixture result.\n`
}
