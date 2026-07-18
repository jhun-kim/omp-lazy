import { realpath } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"
import { type CanonicalRoot, type Uuid, UuidSchema } from "./domain"

export type StatePaths = {
  readonly root: string
  readonly activeIndex: string
  readonly lock: string
  readonly events: string
  readonly runs: string
}

export class StateRootContainmentError extends Error {
  readonly name = "StateRootContainmentError"
  constructor(readonly code: "state_root_escaped" | "state_root_unreadable") {
    super(code)
  }
}

export type StatePathGuard = (path: string) => Promise<void>

export function canonicalComparisonPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/, "")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

export function isCanonicalPathContained(root: string, candidate: string): boolean {
  const canonicalRoot = canonicalComparisonPath(root)
  const canonicalCandidate = canonicalComparisonPath(candidate)
  return canonicalCandidate === canonicalRoot || canonicalCandidate.startsWith(`${canonicalRoot}/`)
}

export function isDisplayPathContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..")
}

export function statePaths(root: CanonicalRoot): StatePaths {
  const stateRoot = join(root.displayPath, ".omo", "omp-lazy")
  return {
    root: stateRoot,
    activeIndex: join(stateRoot, "active.json"),
    lock: join(stateRoot, "state.lock"),
    events: join(stateRoot, "events"),
    runs: join(stateRoot, "runs"),
  }
}

export function runSnapshotPath(root: CanonicalRoot, runId: Uuid): string {
  return join(statePaths(root).runs, UuidSchema.parse(runId), "run.json")
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

async function nearestExistingCanonicalPath(path: string): Promise<string> {
  let candidate = path
  while (true) {
    try {
      return await realpath(candidate)
    } catch (error) {
      if (!isMissing(error)) throw new StateRootContainmentError("state_root_unreadable")
      const parent = dirname(candidate)
      if (parent === candidate) throw new StateRootContainmentError("state_root_unreadable")
      candidate = parent
    }
  }
}

export async function ensureStatePathContained(root: CanonicalRoot, path: string): Promise<void> {
  const lexical = canonicalComparisonPath(path)
  if (!isCanonicalPathContained(root.canonicalPath, lexical)) {
    throw new StateRootContainmentError("state_root_escaped")
  }
  const resolved = canonicalComparisonPath(await nearestExistingCanonicalPath(path))
  if (!isCanonicalPathContained(root.canonicalPath, resolved)) {
    throw new StateRootContainmentError("state_root_escaped")
  }
}

export async function ensureStateRootContained(root: CanonicalRoot): Promise<void> {
  await ensureStatePathContained(root, statePaths(root).root)
}
