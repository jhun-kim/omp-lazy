import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { lstat, mkdir, readdir, readFile, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import type { CanonicalRoot } from "../../src/state/domain"
import { inspectRecovery } from "../../src/state/recovery"
import { initializedStore } from "../fixtures/store-fixtures"

const roots: string[] = []
const runRoot = join(tmpdir(), `omp-lazy-t04-state-root-${process.pid}`)
const REDIRECT_CASES = [
  { label: "omo-junction", linkPath: [".omo"], linkType: "junction" },
  { label: "state-junction", linkPath: [".omo", "omp-lazy"], linkType: "junction" },
  { label: "omo-symlink", linkPath: [".omo"], linkType: "dir" },
  { label: "state-symlink", linkPath: [".omo", "omp-lazy"], linkType: "dir" },
] as const

type RedirectCase = (typeof REDIRECT_CASES)[number]
type ExternalEntry =
  | { readonly kind: "dir"; readonly path: string }
  | { readonly kind: "file"; readonly path: string; readonly bytes: string }

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

afterAll(async () => {
  await rm(runRoot, { recursive: true, force: true })
})

async function sandbox(label: string): Promise<string> {
  const path = join(runRoot, label)
  await rm(path, { recursive: true, force: true })
  await mkdir(path, { recursive: true })
  roots.push(path)
  return realpath(path)
}

async function canonicalRoot(path: string): Promise<CanonicalRoot> {
  const displayPath = await realpath(path)
  return { canonicalPath: displayPath.replaceAll("\\", "/").toLowerCase(), displayPath }
}

async function relativeFiles(path: string): Promise<readonly string[]> {
  const names = await readdir(path, { recursive: true })
  const files: string[] = []
  for (const name of names) {
    const normalized = name.toString().replaceAll("\\", "/")
    files.push(normalized)
  }
  return files.sort()
}

function isFileError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

async function commitOutcome(root: CanonicalRoot): Promise<"resolved" | "rejected"> {
  try {
    await initializedStore(root)
    return "resolved"
  } catch (error) {
    if (error instanceof Error) return "rejected"
    throw error
  }
}

async function externalEntries(path: string): Promise<readonly ExternalEntry[]> {
  const names = await readdir(path, { recursive: true })
  const entries: ExternalEntry[] = []
  for (const name of names) {
    const normalized = name.toString().replaceAll("\\", "/")
    const stats = await lstat(join(path, normalized))
    if (stats.isDirectory()) {
      entries.push({ kind: "dir", path: normalized })
    } else {
      entries.push({
        kind: "file",
        path: normalized,
        bytes: await readFile(join(path, normalized), "utf8"),
      })
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path))
}

async function redirectStateRoot(
  root: CanonicalRoot,
  external: string,
  testCase: RedirectCase,
): Promise<"created" | "not_run"> {
  const linkPath = join(root.displayPath, ...testCase.linkPath)
  if (testCase.linkPath.length > 1) await mkdir(join(root.displayPath, ".omo"), { recursive: true })
  try {
    await symlink(external, linkPath, testCase.linkType)
    return "created"
  } catch (error) {
    if (
      testCase.linkType === "dir" &&
      (isFileError(error, "EPERM") || isFileError(error, "EACCES"))
    ) {
      console.info(`NOT_RUN ${testCase.label}: directory symlink privilege unavailable`)
      return "not_run"
    }
    throw error
  }
}

function expectStateFiles(files: readonly string[]): void {
  expect(files).toContain("active.json")
  expect(files).toContain("events/0000000000000001-55555555-5555-4555-8555-555555555555.json")
  expect(files).toContain("runs/11111111-1111-4111-8111-111111111111/run.json")
  expect(files.some((name) => name.includes(".tmp-"))).toBeFalse()
  expect(files).not.toContain("state.lock")
}

describe("state root containment", () => {
  test("Given contained baseline ordinary repository state root When committing Then lock event run index temp and recovery bytes stay contained", async () => {
    // Given
    const root = await canonicalRoot(await sandbox("ordinary-root"))

    // When
    await initializedStore(root)
    const stateFiles = await relativeFiles(join(root.displayPath, ".omo", "omp-lazy"))
    const recovery = await inspectRecovery(root)

    // Then
    expectStateFiles(stateFiles)
    expect(recovery).toEqual({ kind: "healthy", revision: 1 })
  })

  test("Given contained baseline state root junction inside the repository When committing Then nested state remains canonical-repo contained", async () => {
    // Given
    const root = await canonicalRoot(await sandbox("contained-state-root"))
    const contained = join(root.displayPath, ".omo-contained-state")
    await mkdir(join(root.displayPath, ".omo"), { recursive: true })
    await mkdir(contained, { recursive: true })
    await symlink(contained, join(root.displayPath, ".omo", "omp-lazy"), "junction")

    // When
    await initializedStore(root)
    const stateFiles = await relativeFiles(contained)
    const recovery = await inspectRecovery(root)

    // Then
    expect(relative(root.displayPath, contained).startsWith("..")).toBeFalse()
    expectStateFiles(stateFiles)
    expect(recovery).toEqual({ kind: "healthy", revision: 1 })
  })

  for (const testCase of REDIRECT_CASES) {
    test(`Given ${testCase.label} redirects state outside the repository When committing Then no lock event run index temp or recovery bytes escape`, async () => {
      // Given
      const root = await canonicalRoot(await sandbox(`escape-${testCase.label}-repo`))
      const external = await sandbox(`escape-${testCase.label}-external`)
      const redirect = await redirectStateRoot(root, external, testCase)
      if (redirect === "not_run") return

      // When
      const outcome = await commitOutcome(root)
      const escaped = await externalEntries(external)

      // Then
      expect({ outcome, escaped }).toEqual({ outcome: "rejected", escaped: [] })
    })
  }
})
