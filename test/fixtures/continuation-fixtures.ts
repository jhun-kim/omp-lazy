import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { type StartWorkRun, UuidSchema } from "../../src/state/domain"
import { deadlineAfter } from "../../src/state/repo-lock"
import { TransactionStore } from "../../src/state/transaction-store"
import { parseStartWorkPlan } from "../../src/workflows/start-work-plan"
import { createEvent, startRun, temporaryRoot } from "./store-fixtures"

export const CONTINUATION_PLAN =
  "<!-- omp-lazy-ulw-plan:plan:v1 -->\n## TODOs\n- [ ] Build durable state\n- [ ] Verify continuation\n\n## Final Verification Wave\n- [ ] Review evidence\n"

export async function initializedContinuationStore(label: string): Promise<{
  readonly root: Awaited<ReturnType<typeof temporaryRoot>>
  readonly run: StartWorkRun
  readonly store: TransactionStore
}> {
  const root = await temporaryRoot(label)
  const seed = startRun(root)
  const plan = parseStartWorkPlan(CONTINUATION_PLAN)
  const run: StartWorkRun = {
    ...seed,
    payload: {
      ...seed.payload,
      plan: {
        ...seed.payload.plan,
        taskFingerprint: plan.fingerprint,
        taskIds: plan.taskIds,
      },
    },
  }
  await mkdir(dirname(run.payload.plan.displayPath), { recursive: true })
  await writeFile(run.payload.plan.displayPath, CONTINUATION_PLAN)
  const store = new TransactionStore(root)
  const created = await store.commit(createEvent(run), { deadline: deadlineAfter(2_000) })
  if (!created.ok || created.run.workflow !== "start_work") {
    throw new Error("continuation fixture commit failed")
  }
  return { root, run: created.run, store }
}

export function durableDependencies(
  root: Awaited<ReturnType<typeof temporaryRoot>>,
  store: TransactionStore,
) {
  return {
    resolveRoot: async () => root,
    openStore: () => store,
    readPlan: async (path: string) => readFile(path, "utf8"),
    eventId: () => UuidSchema.parse(crypto.randomUUID()),
    nowIso: () => new Date().toISOString(),
  }
}
