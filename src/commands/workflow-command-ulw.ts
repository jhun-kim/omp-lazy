import { join } from "node:path"
import { evidenceRootPath } from "../contracts/artifact-containment"
import { readGitEvidenceBinding } from "../contracts/git-evidence-binding"
import { WorkerAcceptanceLedger } from "../contracts/worker-acceptance-ledger"
import type { StateMutation, UlwLoopRun } from "../state/domain"
import { newRunId } from "../state/domain"
import type { WorkflowCommandResult } from "./command-result"
import { readSteeringInput, repositoryRelativePath } from "./workflow-command-inputs"
import {
  type CommandContext,
  commitMutation,
  control,
  createEvent,
  deterministicEventId,
  lookupRun,
  mutationEvent,
  result,
} from "./workflow-command-runtime"

export async function executeUlwCommand(context: CommandContext): Promise<WorkflowCommandResult> {
  if (["pause", "resume", "cancel", "adopt"].includes(context.parsed.operation)) {
    return control(context, "ulw_loop")
  }
  if (context.parsed.operation === "status") {
    const found = await lookupRun({
      store: context.store,
      workflow: "ulw_loop",
      sessionId: context.sessionId,
      targetRunId: context.parsed.words[0],
    })
    return found.ok
      ? result(context, "PASS", { run: found.run })
      : result(context, "BLOCKED", { code: found.code })
  }
  if (context.parsed.operation === "create") return createUlwRun(context)
  return context.parsed.operation === "steer" ? steerUlwRun(context) : checkpointUlwRun(context)
}

async function createUlwRun(context: CommandContext): Promise<WorkflowCommandResult> {
  const objective = context.parsed.words.join(" ").normalize("NFC")
  const existing = await lookupRun({
    store: context.store,
    workflow: "ulw_loop",
    sessionId: context.sessionId,
  })
  if (existing.ok && existing.run.workflow === "ulw_loop") {
    return existing.run.payload.objective === objective
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
  const run: UlwLoopRun = {
    schemaVersion: 2,
    packetHash: null,
    expectedHead: git.head,
    runId: newRunId(),
    workflow: "ulw_loop",
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
      kind: "ulw_loop",
      objective,
      status: "active",
      activeGoalId: "goal-1",
      goals: [
        {
          id: "goal-1",
          status: "in_progress",
          cycleCount: 0,
          criteria: [
            {
              id: "criterion-1",
              status: "pending",
              identicalFailureFingerprint: null,
              identicalFailureCount: 0,
              evidenceRef: null,
              captureRevision: null,
              captureCommit: null,
            },
          ],
        },
      ],
    },
  }
  const committed = await commitMutation(context.store, createEvent(index.revision, run))
  return committed.ok
    ? result(context, "PASS", { run: committed.run })
    : result(context, "BLOCKED", { code: committed.code })
}

async function steerUlwRun(context: CommandContext): Promise<WorkflowCommandResult> {
  const found = await lookupRun({
    store: context.store,
    workflow: "ulw_loop",
    sessionId: context.sessionId,
    targetRunId: context.parsed.words[0],
  })
  if (!found.ok || found.run.workflow !== "ulw_loop") {
    return result(context, "BLOCKED", { code: found.ok ? "missing_target" : found.code })
  }
  const steering = await readSteeringInput(context.store, context.parsed.words[1] ?? "")
  if (!steering.ok) return result(context, "BLOCKED", { code: steering.code })
  if (steering.value.runId !== found.run.runId) {
    return result(context, "BLOCKED", { code: "task_scope_mismatch" })
  }
  if (steering.value.expectedRevision !== found.run.revision) {
    const event = await context.store.readEvent(
      deterministicEventId(
        `${found.run.runId}\u0000workflow_steered\u0000${steering.value.idempotencyKey}`,
      ),
    )
    if (event === null) return result(context, "BLOCKED", { code: "stale_revision" })
  }
  const git = await readGitEvidenceBinding(context.store.root)
  if (!git.ok) return result(context, "BLOCKED", { code: git.code })
  if (steering.value.expectedHead !== git.head) {
    return result(context, "BLOCKED", { code: "stale_head" })
  }
  const mutation: StateMutation = {
    kind: "workflow_steered",
    criteria: steering.value.addCriteria,
    ...(steering.value.annotation === undefined ? {} : { annotation: steering.value.annotation }),
  }
  const committed = await commitMutation(
    context.store,
    await mutationEvent({
      store: context.store,
      run: found.run,
      mutation,
      expectedHead: git.head,
      taskGeneration: found.run.progressRevision,
      idempotencyKey: steering.value.idempotencyKey,
    }),
  )
  return committed.ok
    ? result(context, "PASS", { run: committed.run })
    : result(context, "BLOCKED", { code: committed.code })
}

async function checkpointUlwRun(context: CommandContext): Promise<WorkflowCommandResult> {
  const [runId, criterionId, evidencePath] = context.parsed.words
  const found = await lookupRun({
    store: context.store,
    workflow: "ulw_loop",
    sessionId: context.sessionId,
    targetRunId: runId,
  })
  if (!found.ok || found.run.workflow !== "ulw_loop") {
    return result(context, "BLOCKED", { code: found.ok ? "missing_target" : found.code })
  }
  const goal = found.run.payload.goals.find((candidate) =>
    candidate.criteria.some((criterion) => criterion.id === criterionId),
  )
  if (goal === undefined || evidencePath === undefined) {
    return result(context, "BLOCKED", { code: "task_scope_mismatch" })
  }
  const entries = await new WorkerAcceptanceLedger(context.store).scopedEntries(found.run.runId)
  const accepted = entries.find((entry) => {
    const absolute = join(
      evidenceRootPath(context.store.root, found.run.runId, entry.attempt),
      entry.receiptPath,
    )
    return (
      entry.taskId === criterionId &&
      entry.ownerSessionId === context.sessionId &&
      entry.ownerEpoch === found.run.owner.epoch &&
      entry.runRevision === found.run.revision &&
      repositoryRelativePath(context.store, absolute) === evidencePath.replaceAll("\\", "/")
    )
  })
  if (accepted === undefined) {
    return result(context, "BLOCKED", { code: "task_scope_mismatch" })
  }
  const git = await readGitEvidenceBinding(context.store.root)
  if (!git.ok) return result(context, "BLOCKED", { code: git.code })
  if (accepted.captureCommit !== git.head) return result(context, "BLOCKED", { code: "stale_head" })
  const mutation: StateMutation = {
    kind: "criterion_settled",
    goalId: goal.id,
    criterionId: criterionId ?? "",
    evidenceRef: evidencePath,
    captureRevision: accepted.runRevision,
    captureCommit: accepted.captureCommit,
  }
  const committed = await commitMutation(
    context.store,
    await mutationEvent({
      store: context.store,
      run: found.run,
      mutation,
      expectedHead: git.head,
      taskGeneration: accepted.taskGeneration,
      idempotencyKey: accepted.idempotencyKey,
    }),
  )
  return committed.ok
    ? result(context, "PASS", { run: committed.run })
    : result(context, "BLOCKED", { code: committed.code })
}
