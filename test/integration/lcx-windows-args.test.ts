import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseLcxWindowsAdapterArguments } from "../../src/workflows/lcx-contract"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

describe("lcx Windows adapter arguments", () => {
  test("preserves absolute Windows paths containing spaces as literal arguments", async () => {
    // Given: a disposable Windows workspace whose paths contain spaces.
    const root = await mkdtemp(join(process.cwd(), ".todo16 windows args "))
    roots.push(root)
    const ompExecutable = join(root, "OMP Runtime", "omp.exe")
    const evidenceRoot = join(root, "Evidence Bundle")
    await mkdir(join(root, "OMP Runtime"), { recursive: true })
    await mkdir(evidenceRoot, { recursive: true })
    await writeFile(ompExecutable, "fixture")

    // When: the offline adapter parses an argv array rather than a shell string.
    const result = parseLcxWindowsAdapterArguments([
      "--project-root",
      root,
      "--omp-exe",
      ompExecutable,
      "--evidence-root",
      evidenceRoot,
    ])

    // Then: every literal path is retained and the adapter defaults offline.
    expect(result).toEqual({
      ok: true,
      value: { evidenceRoot, mode: "offline", ompExecutable, projectRoot: root },
    })
  })

  test("rejects drive-relative, missing-value, and unknown arguments", () => {
    // Given/When/Then: malformed Windows paths and arguments fail closed.
    expect(
      parseLcxWindowsAdapterArguments([
        "--project-root",
        "C:relative",
        "--omp-exe",
        "C:\\omp.exe",
        "--evidence-root",
        "C:\\evidence",
      ]),
    ).toEqual({ ok: false, code: "absolute_windows_path_required" })
    expect(parseLcxWindowsAdapterArguments(["--project-root"])).toEqual({
      ok: false,
      code: "invalid_arguments",
    })
    expect(parseLcxWindowsAdapterArguments(["--online"])).toEqual({
      ok: false,
      code: "invalid_arguments",
    })
  })

  test("rejects root-relative paths that depend on the current drive", () => {
    // Given: rooted paths without explicit drive qualifiers.
    const argv = [
      "--project-root",
      "\\repo",
      "--omp-exe",
      "\\omp.exe",
      "--evidence-root",
      "\\evidence",
    ] as const

    // When: the offline adapter parses the drive-context-dependent paths.
    const result = parseLcxWindowsAdapterArguments(argv)

    // Then: root-relative input is rejected rather than resolved implicitly.
    expect(result).toEqual({ ok: false, code: "absolute_windows_path_required" })
  })

  test("generates an offline PR body with Windows input and output paths", async () => {
    // Given: an evidence-backed contribution body input in a spaced Windows path.
    const root = await mkdtemp(join(process.cwd(), ".todo16 pr body "))
    roots.push(root)
    const inputPath = join(root, "evidence input.json")
    const outputPath = join(root, "draft output.md")
    await writeFile(
      inputPath,
      `\uFEFF${JSON.stringify({
        approach: "Apply the smallest contract correction.",
        confidence: "RED, GREEN, and OMP 17.0.5 surface evidence agree.",
        problem: "The compatibility alias selected a different workflow.",
        reproductionLogs: "RED: alias workflow ids differ.",
        risks: "Low; command registration remains unchanged.",
        targetRepository: "omp-lazy",
        title: "Keep compatibility aliases on one workflow",
        userVisibleBehaviorChanges: "Canonical and compatibility commands behave identically.",
        verification: ["RED contract test", "GREEN contract test", "OMP 17.0.5 discovery"],
      })}`,
    )

    // When: the helper is invoked using literal argv entries in mandatory dry-run mode.
    const processResult = Bun.spawnSync(
      [
        "bun",
        join(
          process.cwd(),
          "skills",
          "lcx-contribute-bug-fix(omp)",
          "scripts",
          "create-pr-body.mjs",
        ),
        "--dry-run",
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      { stderr: "pipe", stdout: "pipe" },
    )

    // Then: a local factual body is produced and no publication is claimed.
    expect(processResult.exitCode).toBe(0)
    const body = await readFile(outputPath, "utf8")
    expect(body).toContain("## Problem Situation")
    expect(body).toContain("Target: omp-lazy")
    expect(body).toContain("No issue, pull request, branch push, or network write was performed.")
    expect(body).not.toContain("LazyCodex")
  })
})
