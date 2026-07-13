import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "..", "..")
const sandboxes: string[] = []

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

describe("isolated runner", () => {
  it("uses a fresh allowlisted environment and records cleanup", async () => {
    // Given: an inherited secret and a child that writes its environment.
    const sandbox = await mkdtemp(join(tmpdir(), "omp-lazy-runner-"))
    sandboxes.push(sandbox)
    const probe = join(sandbox, "env.json")
    const child = join(sandbox, "child.ts")
    await writeFile(
      child,
      `await Bun.write(${JSON.stringify(probe)}, JSON.stringify(process.env))\n`,
    )

    // When: the child runs through the isolation boundary.
    const processResult = Bun.spawnSync({
      cmd: [
        "bun",
        "scripts/run-isolated.ts",
        "--timeout-ms",
        "120000",
        "--cwd",
        sandbox,
        "--env-profile",
        "unit",
        "--",
        "bun",
        child,
      ],
      cwd: root,
      env: { ...process.env, OPENAI_API_KEY: "must-not-cross" },
      stderr: "pipe",
      stdout: "pipe",
    })

    // Then: secrets are omitted, roots are contained, and cleanup is reported.
    expect(processResult.exitCode).toBe(0)
    const environment = JSON.parse(await readFile(probe, "utf8"))
    expect(environment.OPENAI_API_KEY).toBeUndefined()
    expect(environment.PI_CONFIG_DIR).toBe(".omp")
    expect(environment.USERPROFILE.startsWith(sandbox)).toBe(true)
    const receipt = JSON.parse(new TextDecoder().decode(processResult.stdout))
    expect(receipt.cleanup).toEqual({ processTree: "complete", sandbox: "complete" })
  })

  it("fails when bun test collects zero tests", () => {
    // Given: an empty directory presented to Bun's test runner.
    const empty = join(import.meta.dir, "fixtures", "empty")

    // When: it is invoked through the checked-in runner.
    const result = Bun.spawnSync({
      cmd: [
        "bun",
        "scripts/run-isolated.ts",
        "--timeout-ms",
        "120000",
        "--cwd",
        root,
        "--env-profile",
        "unit",
        "--",
        "bun",
        "test",
        empty,
      ],
      cwd: root,
      stderr: "pipe",
      stdout: "pipe",
    })

    // Then: a zero-collection run is rejected.
    expect(result.exitCode).not.toBe(0)
  })
})
