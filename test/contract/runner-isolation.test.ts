import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { repositoryRoot, run } from "../fixtures/package-test-helpers"

const sandboxes: string[] = []
const runnerProcessTimeoutMs = 120_000
const runnerAssertionTimeoutMs = runnerProcessTimeoutMs + 5_000

afterEach(async () =>
  Promise.all(sandboxes.splice(0).map((path) => rm(path, { force: true, recursive: true }))),
)

describe("probe runner isolation", () => {
  it(
    "keeps the assertion deadline above the isolated credential probe",
    async () => {
      // Given: a valid extension and a hostile inherited provider credential.
      const sandbox = await mkdtemp(join(repositoryRoot, ".todo3-runner-"))
      sandboxes.push(sandbox)
      const extension = join(sandbox, "extension.ts")
      await writeFile(extension, "await Bun.sleep(5_500); export default function fixture() {}\n")

      // When: the loader probe is launched through the checked-in isolation wrapper.
      const result = run(
        [
          "bun",
          "scripts/run-isolated.ts",
          "--timeout-ms",
          `${runnerProcessTimeoutMs}`,
          "--cwd",
          sandbox,
          "--env-profile",
          "integration",
          "--",
          "bun",
          join(repositoryRoot, "scripts", "probe-loader.ts"),
          "--extension",
          extension,
          "--cwd",
          sandbox,
        ],
        repositoryRoot,
        { OPENAI_API_KEY: "must-not-cross" },
      )

      // Then: the probe passes without the inherited secret appearing in raw evidence.
      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toContain("must-not-cross")
      const wrapper = JSON.parse(result.stdout)
      expect(wrapper.cleanup).toEqual({ processTree: "complete", sandbox: "complete" })
    },
    runnerAssertionTimeoutMs,
  )
})
