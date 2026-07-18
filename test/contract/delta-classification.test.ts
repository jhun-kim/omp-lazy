import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BASE_COMMIT,
  CANDIDATE_COMMIT,
  type DeltaClassificationDocument,
  verifyDeltaClassification,
} from "../../scripts/verify-delta-classification"
import { run } from "../fixtures/package-test-helpers"

const temporaryRoots: string[] = []

type GitCommandResult = {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

type DiffFixtureEntry = {
  readonly path: string
  readonly status: string
}

afterEach(async () =>
  Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true }))),
)

async function temporaryJson(name: string, value: DeltaClassificationDocument): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omp-lazy-delta-classification-"))
  temporaryRoots.push(root)
  const path = join(root, name)
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
  return path
}

function entry(path: string, sourceCommit = CANDIDATE_COMMIT) {
  return {
    path,
    status: "A",
    category: "test",
    decision: "adapt",
    sourceCommit,
  } as const
}

function gitOutput(arguments_: readonly string[]): string {
  const result = Bun.spawnSync({
    cmd: ["git", ...arguments_],
    stderr: "pipe",
    stdout: "pipe",
  })
  const decoder = new TextDecoder()
  const commandResult: GitCommandResult = {
    exitCode: result.exitCode,
    stderr: decoder.decode(result.stderr),
    stdout: decoder.decode(result.stdout),
  }
  expect(commandResult.exitCode).toBe(0)
  return commandResult.stdout
}

function immutableDiffFixture(): readonly DiffFixtureEntry[] {
  return gitOutput(["diff", "--name-status", `${BASE_COMMIT}..${CANDIDATE_COMMIT}`])
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const fields = line.split("\t")
      const status = fields[0]
      const path = fields[fields.length - 1]
      expect(status).toBeDefined()
      expect(path).toBeDefined()
      return { path: path ?? "", status: status ?? "" }
    })
}

async function temporaryCompleteClassification(): Promise<string> {
  return temporaryJson("complete-delta-classification.json", {
    schemaVersion: 1,
    frozenRange: { base: BASE_COMMIT, candidate: CANDIDATE_COMMIT },
    entries: immutableDiffFixture().map((diffEntry) => ({
      path: diffEntry.path,
      status: diffEntry.status,
      category: "test",
      decision: "adapt",
      sourceCommit: CANDIDATE_COMMIT,
    })),
  })
}

describe("delta classification verifier", () => {
  it("passes when the classification covers the immutable diff exactly once", async () => {
    // Given: a complete temporary classification generated from immutable Git data.
    const classificationPath = await temporaryCompleteClassification()

    // When: the reusable verifier compares it to the frozen commit range.
    const result = await verifyDeltaClassification({
      classificationPath,
      base: BASE_COMMIT,
      candidate: CANDIDATE_COMMIT,
    })

    // Then: all immutable diff paths are accounted for exactly once.
    expect(result.status).toBe("PASS")
    expect(result.pathCount).toBe(118)
    expect(result.classifiedCount).toBe(118)
    expect(result.reasons).toEqual([])
    expect(classificationPath.includes(".omo/evidence")).toBe(false)
  })

  it("rejects duplicate and omitted immutable diff paths", async () => {
    // Given: one real diff path is omitted and another is duplicated.
    const classificationPath = await temporaryJson("duplicate-omitted.json", {
      schemaVersion: 1,
      frozenRange: { base: BASE_COMMIT, candidate: CANDIDATE_COMMIT },
      entries: [entry(".gitignore"), entry(".gitignore")],
    })

    // When: the verifier compares the malformed classification to the frozen range.
    const result = await verifyDeltaClassification({
      classificationPath,
      base: BASE_COMMIT,
      candidate: CANDIDATE_COMMIT,
    })

    // Then: it names both the duplicate and a missing path.
    expect(result.status).toBe("FAIL")
    expect(result.reasons).toContain("duplicate path: .gitignore")
    expect(result.reasons).toContain("omitted path: agents/omp-lazy-explorer.md")
  })

  it("rejects mutable branch names before reading the classification file", () => {
    // Given: a caller supplies a mutable ref instead of a full immutable SHA.
    const command = [
      "bun",
      "scripts/verify-delta-classification.ts",
      "--classification",
      ".omo/evidence/plugin-completion-60/T01/delta-classification.json",
      "--base",
      "main",
      "--candidate",
      CANDIDATE_COMMIT,
    ]

    // When: the CLI boundary parses arguments.
    const result = run(command)

    // Then: it fails closed with the bad argument named.
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("invalid CLI arguments")
    expect(result.stderr).toContain("base")
  })

  it("rejects unknown categories and decisions through the Zod JSON boundary", async () => {
    // Given: the classification file uses values outside the approved taxonomy.
    const root = await mkdtemp(join(tmpdir(), "omp-lazy-delta-classification-"))
    temporaryRoots.push(root)
    const classificationPath = join(root, "bad-taxonomy.json")
    await writeFile(
      classificationPath,
      `${JSON.stringify({
        schemaVersion: 1,
        frozenRange: { base: BASE_COMMIT, candidate: CANDIDATE_COMMIT },
        entries: [
          {
            path: ".gitignore",
            status: "M",
            category: "runtime-ish",
            decision: "maybe",
            sourceCommit: CANDIDATE_COMMIT,
          },
        ],
      })}\n`,
    )

    // When: the verifier parses external JSON.
    const result = await verifyDeltaClassification({
      classificationPath,
      base: BASE_COMMIT,
      candidate: CANDIDATE_COMMIT,
    })

    // Then: schema failures are reported as verifier failures, not ignored.
    expect(result.status).toBe("FAIL")
    expect(result.reasons.join("\n")).toContain("invalid classification JSON")
  })

  it("rejects source commits outside the frozen range", async () => {
    // Given: a path attributes its source to the base commit instead of a candidate-range commit.
    const classificationPath = await temporaryJson("outside-range.json", {
      schemaVersion: 1,
      frozenRange: { base: BASE_COMMIT, candidate: CANDIDATE_COMMIT },
      entries: [entry(".gitignore", BASE_COMMIT)],
    })

    // When: the verifier checks source commit ancestry.
    const result = await verifyDeltaClassification({
      classificationPath,
      base: BASE_COMMIT,
      candidate: CANDIDATE_COMMIT,
    })

    // Then: the bad source commit is rejected by path.
    expect(result.status).toBe("FAIL")
    expect(result.reasons).toContain(
      `source commit outside frozen range for .gitignore: ${BASE_COMMIT}`,
    )
  })
})
