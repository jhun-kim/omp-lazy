import { afterEach, describe, expect, it } from "bun:test"
import { rm, writeFile } from "node:fs/promises"
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
})
