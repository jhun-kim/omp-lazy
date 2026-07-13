import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { repositoryRoot, run } from "../fixtures/package-test-helpers"

const sandboxes: string[] = []
const loaderTestTimeoutMs = 300_000

afterEach(async () =>
  Promise.all(sandboxes.splice(0).map((path) => rm(path, { force: true, recursive: true }))),
)

describe("public loader probe", () => {
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
})
