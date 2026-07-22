import { describe, expect, it } from "bun:test"
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const materializer = resolve(import.meta.dir, "../../harness-eval/src/materialize.ts")
const rootInputs = ["package.json", "bun.lock", "tsconfig.json", "biome.json"] as const

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omp-lazy-materialize-"))
  await Promise.all(rootInputs.map((path) => cp(path, join(root, path))))
  return root
}

async function materialize(
  root: string,
  failpoint?: string,
): Promise<{ readonly exitCode: number | null; readonly stderr: string }> {
  const child = Bun.spawn(["bun", materializer], {
    cwd: root,
    env:
      failpoint === undefined
        ? process.env
        : { ...process.env, OMP_HARNESS_MATERIALIZE_FAILPOINT: failpoint },
    stderr: "pipe",
    stdout: "pipe",
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  return { exitCode, stderr }
}

describe("harness evaluator materialization", () => {
  for (const failpoint of ["after_fixture_write", "before_publish"]) {
    it(`cleans the sibling temporary tree when ${failpoint} interrupts publication`, async () => {
      // Given an empty root and a deterministic materialization failpoint
      const root = await fixtureRoot()

      try {
        // When materialization stops before its atomic publication
        expect((await materialize(root, failpoint)).exitCode).not.toBe(0)

        // Then no partial destination or temporary sibling tree remains
        expect(await readdir(root)).toEqual([...rootInputs].toSorted())
      } finally {
        await rm(root, { force: true, recursive: true })
      }
    })
  }

  it("publishes a complete deterministic fixture tree once and never overwrites it", async () => {
    // Given an empty root containing only closure inputs
    const root = await fixtureRoot()

    try {
      // When the fixture closure is materialized and a second publication is attempted
      expect(await materialize(root)).toEqual({ exitCode: 0, stderr: "" })
      const manifest = await readFile(join(root, "harness-eval", "manifest.v1.json"), "utf8")
      expect((await materialize(root)).exitCode).not.toBe(0)

      // Then the first complete closure remains byte-identical and no temp tree leaks
      expect(await readFile(join(root, "harness-eval", "manifest.v1.json"), "utf8")).toBe(manifest)
      expect(await readdir(root)).toEqual([...rootInputs, "harness-eval"].toSorted())
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
