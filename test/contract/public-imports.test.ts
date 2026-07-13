import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import ts from "typescript"
import { repositoryRoot } from "../fixtures/package-test-helpers"

describe("public OMP imports", () => {
  it("erases the host type import while retaining the public loader import", async () => {
    // Given: a fixture importing only documented OMP package surfaces.
    const fixture = join(repositoryRoot, "test", "fixtures", "public-extension-import.ts")

    // When: TypeScript erases types from the standalone public-import contract.
    const source = await readFile(fixture, "utf8")
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
    }).outputText

    // Then: the type-only root import is erased and the public loader import compiles.
    expect(source).toContain("import type { ExtensionAPI }")
    expect(output).not.toContain('from "@oh-my-pi/pi-coding-agent"')
    expect(output).toContain("@oh-my-pi/pi-coding-agent/extensibility/extensions/loader")
  }, 30_000)
})
