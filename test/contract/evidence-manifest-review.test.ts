import { afterEach, describe, expect, it } from "bun:test"
import { chmod, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { buildEvidenceManifest } from "../../scripts/evidence-manifest-builder"
import {
  addReviewEvidence,
  createSourceEvidence,
  testCommit,
} from "../fixtures/evidence-manifest-fixtures"

const roots: string[] = []

afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))),
)

async function fixture(): Promise<string> {
  const root = await createSourceEvidence()
  roots.push(root)
  await buildEvidenceManifest({ commit: testCommit, mode: "source", root })
  await addReviewEvidence(root)
  return root
}

describe("review evidence manifest", () => {
  it("binds the source manifest and exact F1-F4 review outputs", async () => {
    // Given
    const root = await fixture()

    // When
    const manifest = await buildEvidenceManifest({ commit: testCommit, mode: "review", root })

    // Then
    expect(manifest.mode).toBe("review")
    expect(manifest.commit).toBe(testCommit)
    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      "final/F1-plan-compliance.md",
      "final/F2-quality-security.md",
      "final/F2-verify-release.txt",
      "final/F3-real-qa.json",
      "final/F4-scope-fidelity.md",
    ])
    expect(manifest.sourceManifest?.path).toBe("final/evidence-manifest.json")
  })

  it("rejects a missing final review receipt", async () => {
    // Given
    const root = await fixture()
    await rm(join(root, "final", "F4-scope-fidelity.md"))

    // When
    const result = buildEvidenceManifest({ commit: testCommit, mode: "review", root })

    // Then
    await expect(result).rejects.toThrow("missing evidence file: final/F4-scope-fidelity.md")
  })

  it("rejects a conditional or failing review verdict", async () => {
    // Given
    const root = await fixture()
    await writeFile(join(root, "final", "F1-plan-compliance.md"), "Verdict: FAIL\n")

    // When
    const result = buildEvidenceManifest({ commit: testCommit, mode: "review", root })

    // Then
    await expect(result).rejects.toThrow("review receipt is not unconditional APPROVE")
  })

  it("rejects an extra final-wave receipt", async () => {
    // Given
    const root = await fixture()
    await writeFile(join(root, "final", "F5-undeclared.md"), "Verdict: APPROVE\n")

    // When
    const result = buildEvidenceManifest({ commit: testCommit, mode: "review", root })

    // Then
    await expect(result).rejects.toThrow("unexpected evidence file: final/F5-undeclared.md")
  })

  it("parses the source manifest from the same bytes that were inspected", async () => {
    // Given: an invalid source manifest whose pathname is repaired only after inspection.
    const root = await fixture()
    const path = join(root, "final", "evidence-manifest.json")
    const valid = await readFile(path, "utf8")
    const invalid = { ...JSON.parse(valid), commit: "b".repeat(40) }
    await chmod(path, 0o666)
    await writeFile(path, `${JSON.stringify(invalid)}\n`)
    let swapped = false

    // When: the path changes to valid bytes after its inspected bytes are fixed.
    const result = buildEvidenceManifest({
      commit: testCommit,
      mode: "review",
      root,
      afterInspection: async (inspectedPath: string) => {
        if (inspectedPath !== "final/evidence-manifest.json") return
        await writeFile(path, valid)
        swapped = true
      },
    })

    // Then: parsing rejects the inspected invalid bytes rather than reopening the repaired path.
    await expect(result).rejects.toThrow("source manifest commit mismatch")
    expect(swapped).toBeTrue()
  })

  it("evaluates approval from the same bytes that were hashed", async () => {
    // Given: a failing F1 receipt whose pathname becomes APPROVE only after inspection.
    const root = await fixture()
    const path = join(root, "final", "F1-plan-compliance.md")
    await writeFile(path, "Verdict: FAIL\n")
    let swapped = false

    // When: the path changes after the entry hash has consumed its opened bytes.
    const result = buildEvidenceManifest({
      commit: testCommit,
      mode: "review",
      root,
      afterInspection: async (inspectedPath: string) => {
        if (inspectedPath !== "final/F1-plan-compliance.md") return
        await writeFile(path, "Verdict: APPROVE\n")
        swapped = true
      },
    })

    // Then: approval rejects the hashed FAIL bytes and the test proves the swap ran.
    await expect(result).rejects.toThrow("review receipt is not unconditional APPROVE")
    expect(swapped).toBeTrue()
  })
})
