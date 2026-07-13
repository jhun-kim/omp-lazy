import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { decodeRun, decodeStateEvent } from "../../src/state/codec"
import type { CanonicalRoot, StartWorkRun, StateEvent } from "../../src/state/domain"
import { canonicalComparisonPath } from "../../src/state/paths"
import { deadlineAfter } from "../../src/state/repo-lock"
import { TransactionStore } from "../../src/state/transaction-store"
import { validStartWorkJson } from "./state-fixtures"

export async function temporaryRoot(label: string): Promise<CanonicalRoot> {
  const displayPath = await mkdtemp(join(tmpdir(), `omp-lazy-${label}-`))
  return { canonicalPath: canonicalComparisonPath(displayPath), displayPath }
}

export function startRun(root: CanonicalRoot): StartWorkRun {
  const raw = JSON.parse(validStartWorkJson())
  raw.transactionRevision = 1
  raw.payload.plan.allowedRoot = root.canonicalPath
  raw.payload.plan.allowedRootDisplay = root.displayPath
  raw.payload.plan.canonicalPath = `${root.canonicalPath}/.omo/plans/work.md`
  raw.payload.plan.displayPath = join(root.displayPath, ".omo", "plans", "work.md")
  const decoded = decodeRun(JSON.stringify(raw), root)
  if (!decoded.ok) throw decoded.error
  if (decoded.value.workflow !== "start_work") throw new Error("fixture workflow mismatch")
  return decoded.value
}

function eventFrom(value: unknown): StateEvent {
  const decoded = decodeStateEvent(JSON.stringify(value))
  if (!decoded.ok) throw decoded.error
  return decoded.value
}

export function createEvent(run: StartWorkRun): StateEvent {
  return eventFrom({
    schemaVersion: 1,
    eventId: "55555555-5555-4555-8555-555555555555",
    sequence: 1,
    runId: run.runId,
    workflow: "start_work",
    kind: "run_created",
    expected: {
      indexRevision: 0,
      runRevision: null,
      ownerSessionId: null,
      ownerEpoch: null,
    },
    mutation: { kind: "run_created", run },
    at: "2026-07-13T00:02:00.000Z",
  })
}

export function pauseEvent(
  run: StartWorkRun,
  eventId = "66666666-6666-4666-8666-666666666666",
): StateEvent {
  return eventFrom({
    schemaVersion: 1,
    eventId,
    sequence: 2,
    runId: run.runId,
    workflow: "start_work",
    kind: "workflow_controlled",
    expected: {
      indexRevision: 1,
      runRevision: run.revision,
      ownerSessionId: run.owner.sessionId,
      ownerEpoch: run.owner.epoch,
    },
    mutation: { kind: "workflow_controlled", control: "pause" },
    at: "2026-07-13T00:03:00.000Z",
  })
}

export async function initializedStore(root: CanonicalRoot): Promise<{
  readonly store: TransactionStore
  readonly run: StartWorkRun
}> {
  const run = startRun(root)
  const store = new TransactionStore(root)
  const created = await store.commit(createEvent(run), { deadline: deadlineAfter(2_000) })
  if (!created.ok) throw new Error(created.code)
  if (created.run.workflow !== "start_work") throw new Error("created workflow mismatch")
  return { store, run: created.run }
}
