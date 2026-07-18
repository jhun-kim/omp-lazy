import { afterEach, describe, expect, it } from "bun:test"
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertSkillSync } from "../../scripts/assert-skill-sync"
import { repositoryRoot, run } from "../fixtures/package-test-helpers"

const candidates: string[] = []

afterEach(async () => {
  await Promise.all(candidates.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

async function copiedSkillsCandidate(prefix: string): Promise<string> {
  const candidate = await mkdtemp(join(tmpdir(), `omp-lazy-skill-sync-${prefix}-`))
  candidates.push(candidate)
  await cp(join(repositoryRoot, "skills"), join(candidate, "skills"), { recursive: true })
  return candidate
}

describe("skill sync contract", () => {
  it("validates command-to-skill mapping and required skill files structurally", async () => {
    // Given: the repository skill surface is the package-owned command companion inventory.
    const root = repositoryRoot

    // When: skill sync is asserted.
    const receipt = await assertSkillSync(root)

    // Then: every command workflow maps to one expected skill and required files are present.
    expect(receipt.status).toBe("PASS")
    expect(receipt.commandToSkill.start_work).toBe("start-work")
    expect(receipt.commandToSkill.ulw_loop).toBe("ulw-loop")
    expect(receipt.requiredFiles).toContain("skills/ulw-loop/references/full-workflow.md")
    expect(receipt.requiredFiles).toContain("skills/ulw-research/ATTRIBUTION.md")
  })

  it("rejects mismatched skill metadata and missing ULW references with distinct failures", async () => {
    // Given: a copied candidate with one command companion renamed and one required reference removed.
    const candidate = await copiedSkillsCandidate("reject")
    await writeFile(
      join(candidate, "skills", "start-work", "SKILL.md"),
      "---\nname: ultrawork\ndescription: mismatched fixture\n---\n\n# Wrong\n",
    )
    await rm(join(candidate, "skills", "ulw-loop", "references", "full-workflow.md"))

    // When: the standalone sync CLI checks the copied surface.
    const result = run(["bun", "scripts/assert-skill-sync.ts", "--root", candidate])

    // Then: structural errors name both independent root causes.
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("skill identity mismatch: start-work -> ultrawork")
    expect(result.stderr).toContain(
      "missing required skill file: ulw-loop/references/full-workflow.md",
    )
  })
})
