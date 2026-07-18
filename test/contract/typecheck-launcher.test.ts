import { afterEach, describe, expect, it } from "bun:test"
import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  copyCandidate,
  removeCandidate,
  repositoryRoot,
  run,
} from "../fixtures/package-test-helpers"

const candidates: string[] = []

afterEach(async () => Promise.all(candidates.splice(0).map(removeCandidate)))

describe("local TypeScript launcher", () => {
  it("typechecks production source explicitly with the locked local compiler", async () => {
    // Given: the checked-in typecheck boundary and production source entrypoint.
    const tsconfig = JSON.parse(await readFile(join(repositoryRoot, "tsconfig.json"), "utf8"))
    const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"))

    // When: the typecheck contract is inspected.
    const include = tsconfig.include
    const typecheck = manifest.scripts.typecheck

    // Then: source, scripts, and tests are covered by the local launcher, never bunx.
    expect(include).toEqual(["src/**/*.ts", "scripts/**/*.ts", "test/**/*.ts"])
    expect(typecheck).toContain("scripts/run-local-tsc.ts --noEmit")
    expect(typecheck).not.toContain("bunx")
  })

  it("rejects a missing local TypeScript installation before invoking tsc", async () => {
    // Given: a copied candidate with a valid manifest but no local TypeScript package.
    const candidate = await copyCandidate("missing-local-typescript")
    candidates.push(candidate)
    await Promise.all([
      cp(
        join(repositoryRoot, "scripts", "run-local-tsc.ts"),
        join(candidate, "scripts", "run-local-tsc.ts"),
        {
          recursive: true,
        },
      ),
      cp(join(repositoryRoot, "tsconfig.json"), join(candidate, "tsconfig.json")),
      mkdir(join(candidate, "src"), { recursive: true }),
    ])
    await writeFile(join(candidate, "src", "index.ts"), "export const ok = true\n")

    // When: the authoritative launcher runs without node_modules/typescript.
    const result = run(["bun", "scripts/run-local-tsc.ts", "--noEmit"], candidate)

    // Then: failure names the local TypeScript authority instead of falling back to network resolution.
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("local TypeScript compiler authority rejected")
  })

  it("rejects source-only type breaks through the production entrypoint", async () => {
    // Given: a copied candidate with the local compiler and a broken production source file.
    const candidate = await copyCandidate("source-type-break")
    candidates.push(candidate)
    await Promise.all([
      cp(
        join(repositoryRoot, "scripts", "run-local-tsc.ts"),
        join(candidate, "scripts", "run-local-tsc.ts"),
        {
          recursive: true,
        },
      ),
      cp(
        join(repositoryRoot, "node_modules", "typescript"),
        join(candidate, "node_modules", "typescript"),
        {
          recursive: true,
        },
      ),
      cp(join(repositoryRoot, "tsconfig.json"), join(candidate, "tsconfig.json")),
      mkdir(join(candidate, "src"), { recursive: true }),
    ])
    await writeFile(join(candidate, "src", "index.ts"), "export const broken: string = 1\n")

    // When: local tsc runs against the copied candidate.
    const result = run(["bun", "scripts/run-local-tsc.ts", "--noEmit"], candidate)

    // Then: the source error is reported deterministically.
    expect(result.exitCode).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain("src/index.ts")
  })

  it("rejects unknown launcher arguments instead of forwarding arbitrary tsc flags", () => {
    // Given: the local launcher boundary.
    const command = ["bun", "scripts/run-local-tsc.ts", "--pretty", "false"]

    // When: unsupported arguments are passed.
    const result = run(command)

    // Then: only the repository's authoritative no-emit typecheck mode is accepted.
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("expected exactly --noEmit")
  })
})
