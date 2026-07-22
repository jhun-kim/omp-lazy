import { readFile } from "node:fs/promises"
import type { ActiveIndex, AnyRun, CanonicalRoot, PersistedStateEvent, Uuid } from "../state/domain"
import { UuidSchema } from "../state/domain"
import type { ReceiptAuthority } from "../state/receipt-authority"
import { resolveAuthoritativeRoot } from "../state/repo-root"
import { TransactionStore } from "../state/transaction-store"
import { parseStartWorkPlan } from "../workflows/start-work-plan"
import {
  type ContinuationCoordinatorPort,
  type CoordinatorRequest,
  type CoordinatorResult,
  decideContinuation,
  type PlanObservation,
} from "./continuation-coordinator"
import type { DeadlineFence } from "./deadline-fence"

export interface ContinuationStorePort {
  readIndex(): Promise<ActiveIndex>
  readRun(runId: string): Promise<AnyRun | null>
  readReceiptAuthority?(run: AnyRun): Promise<ReceiptAuthority>
  commit(
    event: PersistedStateEvent,
    options: { readonly deadline: DeadlineFence },
  ): Promise<
    | { readonly ok: true; readonly run: AnyRun; readonly index: ActiveIndex }
    | { readonly ok: false; readonly code: string }
  >
}

export type DurableCoordinatorDependencies = {
  readonly resolveRoot: (cwd: string) => Promise<CanonicalRoot | null>
  readonly openStore: (root: CanonicalRoot) => ContinuationStorePort
  readonly readPlan: (path: string) => Promise<string | null>
  readonly eventId: () => Uuid
  readonly nowIso: () => string
}

export class DurableContinuationCoordinator implements ContinuationCoordinatorPort {
  constructor(readonly dependencies: DurableCoordinatorDependencies) {}

  async handle(request: CoordinatorRequest): Promise<CoordinatorResult> {
    if (!request.fence.isValid()) return { kind: "quiet" }
    const root = await this.dependencies.resolveRoot(request.cwd)
    if (root === null || !request.fence.isValid()) return { kind: "quiet" }
    const store = this.dependencies.openStore(root)
    const index = await store.readIndex()
    if (!request.fence.isValid()) return { kind: "quiet" }
    const entries = index.entries.filter((entry) => entry.sessionId === request.sessionId)
    const loaded = await Promise.all(entries.map((entry) => store.readRun(entry.runId)))
    if (!request.fence.isValid()) return { kind: "quiet" }
    const runs = loaded.filter((run): run is AnyRun => run !== null)
    const authorities = await Promise.all(
      runs.map(async (run) => ({
        runId: run.runId,
        authority: (await store.readReceiptAuthority?.(run)) ?? {
          taskGeneration: 0,
          accepted: [],
          rejected: [],
        },
      })),
    )
    if (!request.fence.isValid()) return { kind: "quiet" }
    const plans: PlanObservation[] = []
    for (const run of runs) {
      if (run.workflow !== "start_work") continue
      const bytes = await this.dependencies.readPlan(run.payload.plan.displayPath)
      if (!request.fence.isValid()) return { kind: "quiet" }
      if (bytes !== null) plans.push({ runId: run.runId, snapshot: parseStartWorkPlan(bytes) })
    }
    const decision = decideContinuation({
      sessionId: request.sessionId,
      leafId: request.leafId,
      snapshot: { index, runs, plans, authorities },
    })
    if (decision.kind === "quiet" || !request.fence.isValid()) return { kind: "quiet" }
    const common = {
      eventId: this.dependencies.eventId(),
      sequence: index.revision + 1,
      runId: decision.run.runId,
      workflow: decision.run.workflow,
      kind: decision.mutation.kind,
      mutation: decision.mutation,
      at: this.dependencies.nowIso(),
    }
    const event: PersistedStateEvent =
      decision.run.schemaVersion === 2
        ? {
            ...common,
            schemaVersion: 2,
            expected: {
              indexRevision: index.revision,
              runRevision: decision.run.revision,
              ownerSessionId: decision.run.owner.sessionId,
              ownerEpoch: decision.run.owner.epoch,
              expectedHead: decision.kind === "settled" ? decision.run.expectedHead : null,
              taskGeneration: decision.kind === "settled" ? decision.taskGeneration : null,
            },
            legacyHeadUnbound: false,
          }
        : {
            ...common,
            schemaVersion: 1,
            expected: {
              indexRevision: index.revision,
              runRevision: decision.run.revision,
              ownerSessionId: decision.run.owner.sessionId,
              ownerEpoch: decision.run.owner.epoch,
            },
          }
    if (!request.fence.isValid()) return { kind: "quiet" }
    const committed = await store.commit(event, { deadline: request.fence })
    if (!committed.ok || !request.fence.isValid()) return { kind: "quiet" }
    const entry = committed.index.entries.find((candidate) => candidate.runId === event.runId)
    if (
      committed.index.revision !== event.sequence ||
      committed.run.transactionRevision !== event.sequence ||
      committed.run.owner.sessionId !== request.sessionId ||
      committed.run.owner.epoch !== event.expected.ownerEpoch ||
      (decision.kind === "continue" && entry?.transactionRevision !== event.sequence)
    ) {
      return { kind: "quiet" }
    }
    return decision.kind === "continue"
      ? { kind: "continue", additionalContext: decision.additionalContext }
      : { kind: "quiet" }
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

export function createDurableContinuationCoordinator(): DurableContinuationCoordinator {
  return new DurableContinuationCoordinator({
    resolveRoot: async (cwd) => {
      const result = await resolveAuthoritativeRoot({ cwd })
      return result.ok ? result.value : null
    },
    openStore: (root) => new TransactionStore(root),
    readPlan: async (path) => {
      try {
        return await readFile(path, "utf8")
      } catch (error) {
        if (isMissing(error)) return null
        throw error
      }
    },
    eventId: () => UuidSchema.parse(crypto.randomUUID()),
    nowIso: () => new Date().toISOString(),
  })
}
