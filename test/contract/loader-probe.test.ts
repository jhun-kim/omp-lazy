import { afterEach, describe, expect, it } from "bun:test"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expectedProductRuntime } from "../../scripts/product-runtime-contract"
import { repositoryRoot, run } from "../fixtures/package-test-helpers"

const sandboxes: string[] = []
const loaderTestTimeoutMs = 300_000

afterEach(async () =>
  Promise.all(sandboxes.splice(0).map((path) => rm(path, { force: true, recursive: true }))),
)

describe("public loader probe", () => {
  it(
    "verifies the product runtime contract in no-arg product mode",
    async () => {
      // Given: the repository root is the product package root.
      const root = repositoryRoot

      // When: the loader smoke probe runs with no explicit fixture arguments.
      const result = run(["bun", "scripts/probe-loader.ts"], root)

      // Then: it succeeds only after comparing the public loader surface to the product contract.
      expect(result.exitCode).toBe(0)
      const receipt = JSON.parse(result.stdout)
      expect(receipt.mode).toBe("product")
      expect(receipt.commandNames).toEqual(expectedProductRuntime.commandNames)
      expect(receipt.toolNames).toEqual(expectedProductRuntime.toolNames)
      expect(receipt.handlerCounts).toEqual(expectedProductRuntime.handlerCounts)
      expect(receipt.errors).toEqual([])
    },
    loaderTestTimeoutMs,
  )

  it(
    "loads a valid extension and inventories its registrations",
    async () => {
      // Given: a minimal source-only extension using the injected API.
      const sandbox = await mkdtemp(join(repositoryRoot, ".todo3-loader-"))
      sandboxes.push(sandbox)
      const extension = join(sandbox, "extension.ts")
      await writeFile(
        extension,
        'await Bun.sleep(5_500); export default function fixture(pi) { pi.registerCommand("fixture-command", { description: "fixture", handler: async () => {} }); pi.on("input", async () => {}) }\n',
      )

      // When: the public OMP loader probe imports the extension.
      const result = run([
        "bun",
        "scripts/probe-loader.ts",
        "--extension",
        extension,
        "--cwd",
        sandbox,
      ])

      // Then: loading succeeds and registrations come from the loaded runtime object.
      expect(result.exitCode).toBe(0)
      const receipt = JSON.parse(result.stdout)
      expect(receipt.errors).toEqual([])
      expect(receipt.commandNames).toEqual(["fixture-command"])
      expect(receipt.handlerCounts).toEqual({ input: 1 })
    },
    loaderTestTimeoutMs,
  )

  it(
    "returns nonzero for an import-broken extension",
    async () => {
      // Given: a syntactically invalid extension path.
      const sandbox = await mkdtemp(join(repositoryRoot, ".todo3-loader-broken-"))
      sandboxes.push(sandbox)
      const extension = join(sandbox, "broken.ts")
      await writeFile(extension, "export default function broken( {\n")

      // When: the loader probe imports it.
      const result = run([
        "bun",
        "scripts/probe-loader.ts",
        "--extension",
        extension,
        "--cwd",
        sandbox,
      ])

      // Then: link/list-style existence cannot be mistaken for loader success.
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toContain('"errors"')
    },
    loaderTestTimeoutMs,
  )

  it(
    "rejects product mode when a copied candidate is missing an approved command",
    async () => {
      // Given: a copied product candidate omits one command registration at runtime.
      const candidate = await productRuntimeCandidate("missing-command")
      const commandFile = join(candidate, "src", "commands", "command-definitions.ts")
      const source = await readFile(commandFile, "utf8")
      await writeFile(commandFile, source.replace('aliases: ["/teammode(omp)"],', "aliases: [],"))

      // When: the product-mode loader gate runs against the copied candidate root.
      const result = run(["bun", join(repositoryRoot, "scripts", "probe-loader.ts")], candidate)

      // Then: the exact command delta is reported and the process fails.
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('commands inventory mismatch: missing ["teammode(omp)"]')
    },
    loaderTestTimeoutMs,
  )
})

async function productRuntimeCandidate(prefix: string): Promise<string> {
  const candidate = await mkdtemp(join(repositoryRoot, `.todo11-loader-${prefix}-`))
  sandboxes.push(candidate)
  await Promise.all(
    ["package.json", "src", "agents", "skills"].map((entry) =>
      cp(join(repositoryRoot, entry), join(candidate, entry), { recursive: true }),
    ),
  )
  return candidate
}
