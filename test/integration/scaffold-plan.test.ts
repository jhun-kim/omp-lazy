import { afterEach, describe, expect, it } from "bun:test"
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "..", "..")
const script = join(root, "skills", "ulw-plan(omp)", "scripts", "scaffold-plan.mjs")
const fixtureRoot = join(root, "test", "fixtures", "ulw-plan")
const sandboxes: string[] = []

async function sandbox(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `omp-lazy-${name}-`))
  sandboxes.push(path)
  return path
}

function run(cwd: string, args: readonly string[]) {
  return Bun.spawnSync(["node", script, ...args], { cwd, stderr: "pipe", stdout: "pipe" })
}

afterEach(async () =>
  Promise.all(sandboxes.splice(0).map((path) => rm(path, { force: true, recursive: true }))),
)

describe("ulw-plan scaffold", () => {
  it("creates only a durable draft before approval", async () => {
    // Given: an empty non-Git project root.
    const cwd = await sandbox("draft")

    // When: the planner records a CLEAR route before presenting the approval brief.
    const result = run(cwd, ["draft-only", "--clear", "--draft"])

    // Then: the durable draft exists but no plan can exist before approval.
    expect(result.exitCode).toBe(0)
    expect(await readFile(join(cwd, ".omo", "drafts", "draft-only.md"), "utf8")).toContain(
      "status: drafting",
    )
    expect(await Bun.file(join(cwd, ".omo", "plans", "draft-only.md")).exists()).toBe(false)
  })

  it("rejects plan generation when durable approval is missing", async () => {
    // Given: a scaffolded draft whose approval gate is still awaiting approval.
    const cwd = await sandbox("missing-approval")
    expect(run(cwd, ["missing-approval", "--unclear", "--draft"]).exitCode).toBe(0)
    const draftPath = join(cwd, ".omo", "drafts", "missing-approval.md")
    const draft = await readFile(draftPath, "utf8")
    await writeFile(draftPath, draft.replaceAll("status: drafting", "status: awaiting-approval"))

    // When: plan generation is attempted without the explicit durable approval marker.
    const result = run(cwd, ["missing-approval", "--plan"])

    // Then: it fails closed and writes no plan skeleton.
    expect(result.exitCode).not.toBe(0)
    expect(new TextDecoder().decode(result.stderr)).toContain("explicit-user-approval")
    expect(await Bun.file(join(cwd, ".omo", "plans", "missing-approval.md")).exists()).toBe(false)
  })

  it("creates an approved plan with TLDR first and preserves it on compaction resume", async () => {
    // Given: an approved durable draft restored after compaction.
    const cwd = await sandbox("resume")
    await mkdir(join(cwd, ".omo", "drafts"), { recursive: true })
    await copyFile(
      join(fixtureRoot, "approved-draft.md"),
      join(cwd, ".omo", "drafts", "compaction-resume.md"),
    )

    // When: the plan is generated, extended, and the same scaffold command is repeated.
    expect(run(cwd, ["compaction-resume", "--plan"]).exitCode).toBe(0)
    const planPath = join(cwd, ".omo", "plans", "compaction-resume.md")
    const initial = await readFile(planPath, "utf8")
    const appended = `${initial}\n- [ ] durable appended task\n`
    await writeFile(planPath, appended)
    const repeated = run(cwd, ["compaction-resume", "--plan"])

    // Then: the first plan section is TLDR and repeated scaffolding is an exact no-op.
    expect(repeated.exitCode).toBe(0)
    expect(initial.match(/^## .+$/m)?.[0]).toBe("## TL;DR (For humans)")
    expect(await readFile(planPath, "utf8")).toBe(appended)
  })

  it("preflights an existing human plan before writing any sibling artifact", async () => {
    // Given: a same-named human file in the plan destination.
    const cwd = await sandbox("human")
    await mkdir(join(cwd, ".omo", "plans"), { recursive: true })
    await copyFile(join(fixtureRoot, "human-plan.md"), join(cwd, ".omo", "plans", "human.md"))

    // When: even a forced reset is requested.
    const result = run(cwd, ["human", "--clear", "--draft", "--reset", "--force"])

    // Then: the human file remains byte-identical and no draft is partially created.
    expect(result.exitCode).not.toBe(0)
    expect(await readFile(join(cwd, ".omo", "plans", "human.md"), "utf8")).toBe(
      await readFile(join(fixtureRoot, "human-plan.md"), "utf8"),
    )
    expect(await Bun.file(join(cwd, ".omo", "drafts", "human.md")).exists()).toBe(false)
  })

  it("rejects a non-artifact draft collision even with reset and force", async () => {
    // Given: unrelated notes at the draft destination.
    const cwd = await sandbox("collision")
    await mkdir(join(cwd, ".omo", "drafts"), { recursive: true })
    const draftPath = join(cwd, ".omo", "drafts", "collision.md")
    await writeFile(draftPath, "human notes\n")

    // When: scaffold is invoked with its strongest reset flags.
    const result = run(cwd, ["collision", "--draft", "--reset", "--force"])

    // Then: unrelated content wins and no plan is created as a side effect.
    expect(result.exitCode).not.toBe(0)
    expect(await readFile(draftPath, "utf8")).toBe("human notes\n")
    expect(await Bun.file(join(cwd, ".omo", "plans", "collision.md")).exists()).toBe(false)
  })

  it("rejects a symlinked artifact root without touching its target", async () => {
    // Given: .omo is redirected outside the project root.
    const cwd = await sandbox("symlink-root")
    const outside = await sandbox("symlink-target")
    await symlink(outside, join(cwd, ".omo"), "junction")

    // When: scaffold resolves its write parents.
    const result = run(cwd, ["escape", "--draft"])

    // Then: containment fails before any outside artifact is written.
    expect(result.exitCode).not.toBe(0)
    expect(await lstat(join(cwd, ".omo"))).toBeDefined()
    expect(await Bun.file(join(outside, "drafts", "escape.md")).exists()).toBe(false)
  })

  it("rejects traversal and supports an intentional reset only for its own artifact", async () => {
    // Given: a generated draft that was later edited by the planner.
    const cwd = await sandbox("reset")
    expect(run(cwd, ["safe-reset", "--draft"]).exitCode).toBe(0)
    const draftPath = join(cwd, ".omo", "drafts", "safe-reset.md")
    await writeFile(draftPath, `${await readFile(draftPath, "utf8")}\nplanner edit\n`)

    // When: traversal and unforced/forced resets are attempted.
    const traversal = run(cwd, ["../escape", "--draft"])
    const unforced = run(cwd, ["safe-reset", "--draft", "--reset"])
    const forced = run(cwd, ["safe-reset", "--draft", "--reset", "--force"])

    // Then: unsafe paths and accidental resets fail, while explicit reset restores this artifact.
    expect(traversal.exitCode).not.toBe(0)
    expect(unforced.exitCode).not.toBe(0)
    expect(forced.exitCode).toBe(0)
    expect(await readFile(draftPath, "utf8")).not.toContain("planner edit")
  })
})
