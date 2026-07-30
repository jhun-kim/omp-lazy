import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { repositoryRoot } from "../fixtures/package-test-helpers"

const BATCH_FANOUT_TOKENS = ["tasks[]", "isolated: true"] as const

const FANOUT_SKILLS = [
  "teammode(omp)",
  "start-work(omp)",
  "ulw-loop(omp)",
  "ulw-deliver(omp)",
] as const

const NON_FANOUT_SKILLS = [
  "ulw-plan(omp)",
  "ulw-research(omp)",
  "ultrawork(omp)",
  "lcx-contribute-bug-fix(omp)",
  "lcx-doctor(omp)",
  "lcx-report-bug(omp)",
] as const

async function readSkillBody(name: string): Promise<string> {
  return readFile(join(repositoryRoot, "skills", name, "SKILL.md"), "utf8")
}

describe("batch fan-out token contract", () => {
  for (const skill of FANOUT_SKILLS) {
    for (const token of BATCH_FANOUT_TOKENS) {
      it(`${skill} contains required batch token "${token}"`, async () => {
        const body = await readSkillBody(skill)
        expect(body).toContain(token)
      })
    }
  }

  for (const skill of NON_FANOUT_SKILLS) {
    for (const token of BATCH_FANOUT_TOKENS) {
      it(`${skill} does NOT contain batch token "${token}"`, async () => {
        const body = await readSkillBody(skill)
        expect(body).not.toContain(token)
      })
    }
  }

  it("in-memory skill body missing a required token is named by the sync checker", async () => {
    // Prove the sync checker names the exact missing token without on-disk mutation.
    const { assertSkillSync } = await import("../../scripts/assert-skill-sync")
    const { mkdtemp, cp, writeFile } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { rm } = await import("node:fs/promises")

    const candidate = await mkdtemp(join(tmpdir(), "omp-lazy-batch-fanout-neg-"))
    try {
      await cp(join(repositoryRoot, "skills"), join(candidate, "skills"), { recursive: true })
      // Strip "tasks[]" from the teammode skill body.
      const tmPath = join(candidate, "skills", "teammode(omp)", "SKILL.md")
      const original = await readFile(tmPath, "utf8")
      await writeFile(tmPath, original.replace(/tasks\[\]/g, "task_items"), "utf8")

      await expect(assertSkillSync(candidate)).rejects.toThrow(
        "missing skill contract token: teammode(omp) -> tasks[]",
      )
    } finally {
      await rm(candidate, { force: true, recursive: true })
    }
  })
})
