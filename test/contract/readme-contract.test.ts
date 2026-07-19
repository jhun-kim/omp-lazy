import { afterEach, describe, expect, it } from "bun:test"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseShellCommandBlocks, verifyReadmeContract } from "../../scripts/readme-contract"
import { repositoryRoot } from "../fixtures/package-test-helpers"

const roots: string[] = []

afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))),
)

async function copiedContractRoot(): Promise<string> {
  const root = await mkdtemp(join(repositoryRoot, ".t15-readme-"))
  roots.push(root)
  await Promise.all(
    ["README.md", "package.json", "scripts"].map((entry) =>
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
    expect(receipt.commandNames).toHaveLength(18)
    expect(receipt.skillNames).toHaveLength(9)
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
