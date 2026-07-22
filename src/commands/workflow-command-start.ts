import { readGitEvidenceBinding } from "../contracts/git-evidence-binding"
import type { StartWorkRun, StateMutation } from "../state/domain"
import { newRunId } from "../state/domain"
import type { WorkflowCommandResult } from "./command-result"
import { planIsApproved, readContainedPlan } from "./workflow-command-inputs"
import {
  type CommandContext,
  commitMutation,
  control,
  createEvent,
  lookupRun,
  mutationEvent,
  result,
} from "./workflow-command-runtime"

export async function executeStartWorkCommand(
  context: CommandContext,
): Promise<WorkflowCommandResult> {
  if (["pause", "resume", "cancel", "adopt"].includes(context.parsed.operation)) {
    return control(context, "start_work")
  }
  if (context.parsed.operation === "status") {
    const found = await lookupRun({
      store: context.store,
      workflow: "start_work",
      sessionId: context.sessionId,
      targetRunId: context.parsed.words[0],
    })
    return found.ok
      ? result(context, "PASS", { run: found.run })
      : result(context, "BLOCKED", { code: found.code })
  }
  if (context.parsed.operation === "reconcile") return reconcileStartWork(context)
  return createStartWork(context)
}

async function reconcileStartWork(context: CommandContext): Promise<WorkflowCommandResult> {
  const found = await lookupRun({
    store: context.store,
    workflow: "start_work",
    sessionId: context.sessionId,
    targetRunId: context.parsed.words[0],
  })
  if (!found.ok || found.run.workflow !== "start_work") {
    return result(context, "BLOCKED", { code: found.ok ? "missing_target" : found.code })
  }
  const plan = await readContainedPlan(context.store, context.parsed.words[1] ?? "")
  if (!plan.ok) return result(context, "BLOCKED", { code: plan.code })
  if (
    found.run.payload.plan.taskFingerprint !== plan.value.normalized.fingerprint ||
    found.run.payload.plan.taskIds.some((id, index) => id !== plan.value.normalized.taskIds[index])
  ) {
    return result(context, "BLOCKED", { code: "plan_identity_mismatch" })
  }
  const git = await readGitEvidenceBinding(context.store.root)
  if (!git.ok) return result(context, "BLOCKED", { code: git.code })
  const mutation: StateMutation = {
    kind: "plan_reconciled",
    taskIds: plan.value.normalized.taskIds,
    remainingTaskIds: plan.value.normalized.remainingTaskIds,
    taskFingerprint: plan.value.normalized.fingerprint,
  }
  const committed = await commitMutation(
    context.store,
    await mutationEvent({
      store: context.store,
      run: found.run,
      mutation,
      expectedHead: git.head,
      taskGeneration: found.run.progressRevision,
    }),
  )
  return committed.ok
    ? result(context, "PASS", { run: committed.run })
    : result(context, "BLOCKED", { code: committed.code })
}

async function createStartWork(context: CommandContext): Promise<WorkflowCommandResult> {
  const plan = await readContainedPlan(context.store, context.parsed.words[0] ?? "")
  if (!plan.ok) return result(context, "BLOCKED", { code: plan.code })
  if (!(await planIsApproved(context.store, context.sessionId, plan.value.hash))) {
    return result(context, "BLOCKED", { code: "approval_required" })
  }
  const existing = await lookupRun({
    store: context.store,
    workflow: "start_work",
    sessionId: context.sessionId,
  })
  if (existing.ok && existing.run.workflow === "start_work") {
    const same =
      existing.run.payload.plan.canonicalPath === plan.value.canonicalPath &&
      existing.run.payload.plan.taskFingerprint === plan.value.normalized.fingerprint
    return same
      ? result(context, "PASS", { run: existing.run })
      : result(context, "BLOCKED", { code: "idempotency_conflict" })
  }
  if (!existing.ok && existing.code !== "missing_target") {
    return result(context, "BLOCKED", { code: existing.code })
  }
  const git = await readGitEvidenceBinding(context.store.root)
  if (!git.ok) return result(context, "BLOCKED", { code: git.code })
  const index = await context.store.readIndex()
  const at = new Date().toISOString()
  const run: StartWorkRun = {
    schemaVersion: 2,
    packetHash: null,
    expectedHead: git.head,
    runId: newRunId(),
    workflow: "start_work",
    revision: 1,
    transactionRevision: index.revision + 1,
    owner: { sessionId: context.sessionId, epoch: 1 },
    progressRevision: 1,
    continuation: {
      lastProcessedLeafId: null,
      progressRevisionSeen: 1,
      noProgressAttempts: 0,
      stuck: false,
    },
    createdAt: at,
    updatedAt: at,
    payload: {
      kind: "start_work",
      status: "active",
      plan: {
        planId: newRunId(),
        canonicalPath: plan.value.canonicalPath,
        displayPath: plan.value.displayPath,
        allowedRoot: context.store.root.canonicalPath,
        allowedRootDisplay: context.store.root.displayPath,
        taskFingerprint: plan.value.normalized.fingerprint,
        taskIds: plan.value.normalized.taskIds,
      },
    },
  }
  const committed = await commitMutation(context.store, createEvent(index.revision, run))
  return committed.ok
    ? result(context, "PASS", { run: committed.run })
    : result(context, "BLOCKED", { code: committed.code })
}
