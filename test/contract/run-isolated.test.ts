import { afterEach, describe, expect, it } from "bun:test"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

  it("uses the absolute Windows fallback when PATH taskkill fails", async () => {
    if (process.platform !== "win32") return
    // Given: a timeout fixture and a failing PATH taskkill shim.
    const sandbox = await mkdtemp(join(tmpdir(), "omp-lazy-runner-descendant-"))
    sandboxes.push(sandbox)
    const sentinel = join(sandbox, "late-sentinel.txt")
    const fixture = join(root, "test", "fixtures", "delayed-descendant.ts")
    const commandDirectory = join(sandbox, "commands")
    await mkdir(commandDirectory)
    await writeFile(join(commandDirectory, "taskkill.cmd"), "@exit /b 1\r\n")
    const { PATH: inheritedPath = "" } = process.env
    const path =
      process.platform === "win32" ? `${commandDirectory};${inheritedPath}` : inheritedPath

    // When: the authoritative runner times out and falls back to the absolute system taskkill.
    const result = Bun.spawnSync({
      cmd: [
        "bun",
        "scripts/run-isolated.ts",
        "--timeout-ms",
        "25",
        "--cwd",
        sandbox,
        "--env-profile",
        "unit",
        "--",
        "bun",
        fixture,
        "parent",
        sentinel,
      ],
      cwd: root,
      env: { ...process.env, PATH: path },
      stderr: "pipe",
      stdout: "pipe",
    })
    await Bun.sleep(650)
    const sentinelExists = await access(sentinel).then(
      () => true,
      () => false,
    )

    // Then: fallback cleanup is reported and no descendant can mutate after completion.
    expect(result.exitCode).not.toBe(0)
    expect(new TextDecoder().decode(result.stdout)).toContain('"processTree":"complete"')
    expect(sentinelExists).toBeFalse()
  }, 10_000)

  it("returns a cleanup failure when both Windows killers fail instead of hanging", async () => {
    if (process.platform !== "win32") return
    // Given: a hanging PATH taskkill, an unavailable absolute fallback, and a bounded child.
    const sandbox = await mkdtemp(join(tmpdir(), "omp-lazy-runner-killers-fail-"))
    sandboxes.push(sandbox)
    const commandDirectory = join(sandbox, "commands")
    await mkdir(commandDirectory)
    await writeFile(
      join(commandDirectory, "taskkill.cmd"),
      '@powershell.exe -NoProfile -Command "Start-Sleep -Seconds 30"\r\n',
    )
    const { PATH: inheritedPath = "" } = process.env
    const runner = Bun.spawn({
      cmd: [
        "bun",
        "scripts/run-isolated.ts",
        "--timeout-ms",
        "25",
        "--cwd",
        sandbox,
        "--env-profile",
        "unit",
        "--",
        "powershell.exe",
        "-NoProfile",
        "-Command",
        "Start-Sleep -Seconds 2",
      ],
      cwd: root,
      env: {
        ...process.env,
        PATH: `${commandDirectory};${inheritedPath}`,
        SystemRoot: join(sandbox, "missing-system-root"),
      },
      stderr: "pipe",
      stdout: "pipe",
    })

    // When: both cleanup attempts are unavailable.
    const outcome = await Promise.race([
      runner.exited.then((exitCode) => ({ kind: "exited" as const, exitCode })),
      Bun.sleep(6_000).then(() => ({ kind: "hung" as const })),
    ])
    if (outcome.kind === "hung") runner.kill()

    // Then: cleanup failure returns within the outer bound and never claims completion.
    expect(outcome.kind).toBe("exited")
    if (outcome.kind === "exited") expect(outcome.exitCode).not.toBe(0)
    expect(await new Response(runner.stdout).text()).not.toContain('"processTree":"complete"')
  }, 10_000)

  it("cleans a POSIX process group after its leader exits quickly", async () => {
    if (process.platform === "win32") return
    // Given: a parent that exits immediately after spawning a delayed descendant.
    const sandbox = await mkdtemp(join(tmpdir(), "omp-lazy-runner-fast-parent-"))
    sandboxes.push(sandbox)
    const sentinel = join(sandbox, "late-sentinel.txt")
    const fixture = join(root, "test", "fixtures", "delayed-descendant.ts")

    // When: the runner observes the leader exit before its timeout.
    const result = Bun.spawnSync({
      cmd: [
        "bun",
        "scripts/run-isolated.ts",
        "--timeout-ms",
        "5000",
        "--cwd",
        sandbox,
        "--env-profile",
        "unit",
        "--",
        "bun",
        fixture,
        "fast-parent",
        sentinel,
      ],
      cwd: root,
      stderr: "pipe",
      stdout: "pipe",
    })
    await Bun.sleep(650)

    // Then: the surviving process group is terminated before a clean receipt is emitted.
    expect(result.exitCode).toBe(0)
    expect(await Bun.file(sentinel).exists()).toBeFalse()
  }, 10_000)
})
