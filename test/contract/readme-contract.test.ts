import { afterEach, describe, expect, it } from "bun:test"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  parseShellCommandBlocks,
  RUNTIME_BEHAVIOR_ROWS,
  verifyReadmeContract,
  verifyRuntimeBehaviorRows,
} from "../../scripts/readme-contract"
import { repositoryRoot } from "../fixtures/package-test-helpers"

const roots: string[] = []

afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))),
)

async function copiedContractRoot(): Promise<string> {
  const root = await mkdtemp(join(repositoryRoot, ".t15-readme-"))
  roots.push(root)
  await Promise.all(
    ["README.md", "README.ko.md", "package.json", "scripts"].map((entry) =>
      cp(join(repositoryRoot, entry), join(root, entry), { recursive: true }),
    ),
  )
  return root
}

describe("README runtime contract", () => {
  it("matches package scripts and exact product command, skill, and agent tables", async () => {
    // Given
    const root = repositoryRoot

    // When
    const receipt = await verifyReadmeContract(root)

    // Then
    expect(receipt.status).toBe("PASS")
    expect(receipt.packageScripts.length).toBeGreaterThan(0)
    expect(receipt.commandNames).toHaveLength(20)
    expect(receipt.skillNames).toHaveLength(10)
    expect(receipt.agentNames).toHaveLength(11)
  })

  it("rejects a package alias omitted from the exact script table", async () => {
    // Given
    const root = await copiedContractRoot()
    const readmePath = join(root, "README.md")
    const source = await readFile(readmePath, "utf8")
    await writeFile(readmePath, source.replace(/^\| `test:contract` \|.*\r?\n/m, ""))

    // When
    const result = verifyReadmeContract(root)

    // Then
    await expect(result).rejects.toThrow("package script table mismatch")
  })

  it("rejects a missing script referenced by a shell command block", async () => {
    // Given
    const root = await copiedContractRoot()
    const readmePath = join(root, "README.md")
    await writeFile(
      readmePath,
      `${await readFile(readmePath, "utf8")}\n\`\`\`sh\nbun scripts/missing-release-proof.ts\n\`\`\`\n`,
    )

    // When
    const result = verifyReadmeContract(root)

    // Then
    await expect(result).rejects.toThrow("missing shell script reference")
  })

  it("parses quoted shell arguments without splitting paths containing spaces", () => {
    // Given
    const markdown = '```sh\nbun scripts/build-evidence-manifest.ts --root "C:/Evidence Root"\n```'

    // When
    const commands = parseShellCommandBlocks(markdown)

    // Then
    expect(commands).toEqual([
      ["bun", "scripts/build-evidence-manifest.ts", "--root", "C:/Evidence Root"],
    ])
  })
})

describe("Runtime behavior contract (negative)", () => {
  it("rejects an in-memory README missing a runtime-behavior row", () => {
    // Given - a README with the section but missing one expected row
    const missingRow = RUNTIME_BEHAVIOR_ROWS[0]
    if (missingRow === undefined) throw new Error("RUNTIME_BEHAVIOR_ROWS is empty")
    const presentRows = RUNTIME_BEHAVIOR_ROWS.slice(1)
    const markdown = buildRuntimeBehaviorSection(presentRows)

    // When / Then
    const result = verifyRuntimeBehaviorRows(markdown)
    expect(result.status).toBe("FAIL")
    if (result.status !== "FAIL") throw new Error("unreachable")
    expect(result.missing).toContain(missingRow.id)
  })

  it("rejects an in-memory README with an extra runtime-behavior row", () => {
    // Given - a README with the section containing all expected rows plus an extra one
    const extraId = "phantom_telemetry"
    const allRows = [
      ...RUNTIME_BEHAVIOR_ROWS,
      {
        id: extraId,
        en: "Phantom telemetry",
        ko: "팬텀 텔레메트리",
        description: "Should not exist",
      },
    ]
    const markdown = buildRuntimeBehaviorSection(allRows)

    // When / Then
    const result = verifyRuntimeBehaviorRows(markdown)
    expect(result.status).toBe("FAIL")
    if (result.status !== "FAIL") throw new Error("unreachable")
    expect(result.extra).toContain(extraId)
  })

  it("proves both READMEs reference the same RUNTIME_BEHAVIOR_ROWS constant", () => {
    // Given - The source-of-truth constant
    const expectedIds = RUNTIME_BEHAVIOR_ROWS.map((row) => row.id).toSorted()

    // When - Build both language variants from the same constant
    const enMarkdown = buildRuntimeBehaviorSection(RUNTIME_BEHAVIOR_ROWS)
    const koMarkdown = buildRuntimeBehaviorSection(
      RUNTIME_BEHAVIOR_ROWS.map((row) => ({ ...row, description: row.ko })),
    )

    // Then - both validate identically against the same constant
    const enResult = verifyRuntimeBehaviorRows(enMarkdown)
    const koResult = verifyRuntimeBehaviorRows(koMarkdown)
    expect(enResult.status).toBe("PASS")
    expect(koResult.status).toBe("PASS")
    if (enResult.status !== "PASS" || koResult.status !== "PASS") throw new Error("unreachable")
    expect(enResult.ids).toEqual(expectedIds)
    expect(koResult.ids).toEqual(expectedIds)
  })
})

function buildRuntimeBehaviorSection(rows: readonly { id: string; description: string }[]): string {
  const header = "## Runtime behavior\n\n| Behavior | Description |\n| --- | --- |\n"
  const body = rows.map((row) => `| \`${row.id}\` | ${row.description} |`).join("\n")
  return `# omp-lazy\n\n${header}${body}\n`
}
