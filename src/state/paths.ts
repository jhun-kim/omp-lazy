import { join, relative, sep } from "node:path"
import { type CanonicalRoot, type Uuid, UuidSchema } from "./domain"

export type StatePaths = {
  readonly root: string
  readonly activeIndex: string
  readonly lock: string
  readonly events: string
  readonly runs: string
}

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
