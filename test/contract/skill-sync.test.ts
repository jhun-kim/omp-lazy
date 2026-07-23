import { afterEach, describe, expect, it } from "bun:test"
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertSkillSync, type SkillSyncReceipt } from "../../scripts/assert-skill-sync"
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
    expect(receipt.skillNames).toEqual([
      "lcx-contribute-bug-fix(omp)",
      "lcx-doctor(omp)",
      "lcx-report-bug(omp)",
      "start-work(omp)",
      "teammode(omp)",
      "ultrawork(omp)",
      "ulw-deliver(omp)",
      "ulw-loop(omp)",
      "ulw-plan(omp)",
      "ulw-research(omp)",
    ])
    expect(receipt.commandToSkill.start_work).toBe("start-work(omp)")
    expect(receipt.commandToSkill.ulw_loop).toBe("ulw-loop(omp)")
    expect(receipt.requiredFiles).toContain("skills/ulw-loop(omp)/references/full-workflow.md")
    expect(receipt.requiredFiles).toContain("skills/ulw-research(omp)/ATTRIBUTION.md")
  })

  it("rejects mismatched skill metadata and missing ULW references with distinct failures", async () => {
    // Given: a copied candidate with one command companion renamed and one required reference removed.
    const candidate = await copiedSkillsCandidate("reject")
    await writeFile(
      join(candidate, "skills", "start-work(omp)", "SKILL.md"),
      "---\nname: ultrawork(omp)\ndescription: mismatched fixture\n---\n\n# Wrong\n",
    )
    await rm(join(candidate, "skills", "ulw-loop(omp)", "references", "full-workflow.md"))

    // When: the standalone sync CLI checks the copied surface.
    const result = run(["bun", "scripts/assert-skill-sync.ts", "--root", candidate])

    // Then: structural errors name both independent root causes.
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("skill identity mismatch: start-work(omp) -> ultrawork(omp)")
    expect(result.stderr).toContain(
      "missing required skill file: ulw-loop(omp)/references/full-workflow.md",
    )
  })

  it("accepts harmless prose variation when stable protocol markers remain", async () => {
    // Given: copied skills whose generic explanatory prose changes but protocol markers remain.
    const candidate = await copiedSkillsCandidate("prose-variation")
    await writeFile(
      join(candidate, "skills", "start-work(omp)", "SKILL.md"),
      `---
name: start-work(omp)
description: start-work(omp) fixture
---

# Start work

Run an accepted plan from \`.omo/plans\` and settle worker evidence through \`omp_lazy_accept_worker_result\`.
`,
    )
    await writeFile(
      join(candidate, "skills", "ulw-loop(omp)", "SKILL.md"),
      `---
name: ulw-loop(omp)
description: ulw-loop(omp) fixture
---

# ULW loop

Read [the full workflow](references/full-workflow.md) before controlling a run.
`,
    )
    await writeFile(
      join(candidate, "skills", "ulw-research(omp)", "SKILL.md"),
      `---
name: ulw-research(omp)
description: ulw-research(omp) fixture
---

# ulw-research(omp)

Keep [attribution](ATTRIBUTION.md) and require the protocol marker \`EXPAND\` on axis output.
`,
    )

    // When: structural sync validates the copied candidate.
    const receipt: SkillSyncReceipt = await assertSkillSync(candidate)

    // Then: harmless prose edits do not fail machine validation.
    expect(receipt.status).toBe("PASS")
    expect(receipt.skillNames).toContain("start-work(omp)")
  })
})
