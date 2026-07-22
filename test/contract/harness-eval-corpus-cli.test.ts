import { describe, expect, it } from "bun:test"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const manifestPath = join("harness-eval", "manifest.v1.json")
const fixtureRoot = join("harness-eval", "fixtures", "synthetic-target")

type CliResult = { readonly exitCode: number; readonly receipt: unknown }

async function deterministicCorpus(argv: readonly string[]): Promise<CliResult> {
  const child = Bun.spawn(["bun", "harness-eval/src/cli.ts", "run", ...argv], {
    cwd: process.cwd(),
    stderr: "pipe",
    stdout: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(stderr).toBe("")
  return { exitCode, receipt: JSON.parse(stdout) }
}

describe("frozen deterministic corpus CLI", () => {
  it("reports structured PASS for the complete contained corpus", async () => {
    // Given the committed manifest and synthetic target fixture closure
    const argv = [
      "--mode",
      "deterministic",
      "--manifest",
      manifestPath,
      "--validate-corpus",
      "--synthetic-target",
      fixtureRoot,
    ]

    // When the canonical deterministic validation command runs
    const result = await deterministicCorpus(argv)

    // Then it succeeds without a live profile input
    expect(result).toEqual({ exitCode: 0, receipt: { status: "PASS" } })
  })

  it("rejects duplicate and missing scenario authority before oracle execution", async () => {
    // Given copied manifest mutations
    const root = await mkdtemp(join(tmpdir(), "omp-lazy-harness-corpus-"))
    const duplicatePath = join(root, "duplicate.json")
    const missingPath = join(root, "missing.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      scenarioIds: string[]
      scenarios: { id: string }[]
    }
    await writeFile(
      duplicatePath,
      JSON.stringify({
        ...manifest,
        scenarioIds: [...manifest.scenarioIds.slice(0, -1), "plan.clear"],
      }),
    )
    await writeFile(
      missingPath,
      JSON.stringify({
        ...manifest,
        scenarioIds: manifest.scenarioIds.filter((id) => id !== "ulw-loop.repeat-failure"),
        scenarios: manifest.scenarios.filter(
          (scenario) => scenario.id !== "ulw-loop.repeat-failure",
        ),
      }),
    )
    await cp(fixtureRoot, join(root, "fixtures"), { recursive: true })

    try {
      // When each invalid manifest reaches corpus validation
      const [duplicate, missing] = await Promise.all([
        deterministicCorpus([
          "--mode",
          "deterministic",
          "--manifest",
          duplicatePath,
          "--validate-corpus",
          "--synthetic-target",
          join(root, "fixtures"),
        ]),
        deterministicCorpus([
          "--mode",
          "deterministic",
          "--manifest",
          missingPath,
          "--validate-corpus",
          "--synthetic-target",
          join(root, "fixtures"),
        ]),
      ])

      // Then stable authority failures cannot produce a false PASS
      expect(duplicate).toEqual({
        exitCode: 1,
        receipt: { code: "duplicate_scenario_id", status: "FAIL" },
      })
      expect(missing).toEqual({
        exitCode: 1,
        receipt: { code: "required_scenario_missing", status: "FAIL" },
      })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("blocks live evaluation when the required profile input file is absent", async () => {
    // Given a live invocation with its required grammar and no operator input file
    const argv = [
      "--mode",
      "live",
      "--manifest",
      manifestPath,
      "--all",
      "--target-commit",
      "HEAD",
      "--profiles",
      "legacy-low,candidate-high,candidate-low",
      "--credential-ref",
      "ENV:OMP_HARNESS_UPSTREAM_KEY",
    ]

    // When live mode validates the input boundary
    const result = await deterministicCorpus(argv)

    // Then missing public model attestations block only the live mode
    expect(result).toEqual({
      exitCode: 2,
      receipt: { code: "live_profile_input_missing", status: "BLOCKED" },
    })
  })
})
