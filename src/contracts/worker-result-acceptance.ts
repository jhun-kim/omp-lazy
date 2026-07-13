import type { TaskEventLedger } from "../gates/task-event-ledger"
import {
  type RuntimeIdentityRecord,
  runtimeIdentities,
  taskGeneration,
} from "../gates/task-ledger-view"
import type { TaskRunScope } from "../gates/task-sidecar-store"
import type { AnyRun } from "../state/domain"
import type { Deadline } from "../state/repo-lock"
import { deadlineAfter } from "../state/repo-lock"
import { checkWorkingDirectory } from "../state/repo-root"
import { type EvidenceBundle, validateEvidenceBundle } from "./artifact-containment"
import {
  type WorkerAcceptanceInput,
  WorkerAcceptanceInputSchema,
  WorkerRoleSchema,
} from "./evidence-receipt"
import { readGitEvidenceBinding } from "./git-evidence-binding"
import { WorkerAcceptanceLedger } from "./worker-acceptance-ledger"

export type AcceptanceCaller = {
  readonly sessionId: string
  readonly cwd: string
}

export type WorkerAcceptanceResult =
  | { readonly kind: "accepted" | "replayed"; readonly artifactHash: string }
  | {
      readonly kind: "rejected" | "needs_parent_decision"
      readonly code: string
      readonly rejectionCount: number
    }

type DispatchScope = {
  readonly scope: TaskRunScope
  readonly identity: RuntimeIdentityRecord
  readonly generation: number
  readonly input: WorkerAcceptanceInput
}

function isTerminal(run: AnyRun): boolean {
  switch (run.workflow) {
    case "start_work":
      return ["completed", "cancelled", "failed", "abandoned"].includes(run.payload.status)
    case "ulw_loop":
      return ["completed", "cancelled", "failed"].includes(run.payload.status)
    default: {
      const exhaustive: never = run
      return exhaustive
    }
  }
}

function receiptBindingError(
  dispatch: DispatchScope,
  evidence: EvidenceBundle,
  head: string,
): string | null {
  const { receipt } = evidence
  const { run } = dispatch.scope
  if (receipt.runId !== run.runId) return "wrong_run"
  if (receipt.attempt !== run.progressRevision) return "wrong_attempt"
  if (receipt.runRevision !== run.revision) return "wrong_revision"
  if (receipt.ownerEpoch !== run.owner.epoch) return "wrong_owner_epoch"
  if (receipt.taskGeneration !== dispatch.generation) return "wrong_task_generation"
  if (receipt.actualAgentId !== dispatch.identity.actualAgentId) return "wrong_agent_id"
  if (receipt.actualJobId !== dispatch.identity.actualJobId) return "wrong_job_id"
  if (receipt.workerRole !== dispatch.identity.agentType) return "wrong_worker_role"
  if (receipt.captureCommit !== head) return "wrong_capture_commit"
  if (receipt.output.exitCode !== 0) return "nonzero_output"
  if (receipt.output.truncated) return "truncated_output"
  if (receipt.output.schemaOverridden) return "schema_overridden_output"
  if (receipt.output.aborted) return "aborted_output"
  if (receipt.output.blocked) return "blocked_output"
  if (
    receipt.artifacts.some(
      (artifact) =>
        artifact.capture.runId !== run.runId ||
        artifact.capture.attempt !== run.progressRevision ||
        artifact.capture.commit !== head,
    )
  ) {
    return "stale_artifact_metadata"
  }
  return null
}

export class WorkerResultAcceptance {
  readonly acceptanceLedger: WorkerAcceptanceLedger

  constructor(readonly taskLedger: TaskEventLedger) {
    this.acceptanceLedger = new WorkerAcceptanceLedger(taskLedger.store)
  }

  async accept(
    caller: AcceptanceCaller,
    inputValue: unknown,
    signal?: AbortSignal,
  ): Promise<WorkerAcceptanceResult> {
    const parsed = WorkerAcceptanceInputSchema.safeParse(inputValue)
    if (!parsed.success) return { kind: "rejected", code: "malformed_payload", rejectionCount: 0 }
    const deadline = deadlineAfter(2_000)
    const handle = await this.taskLedger.store.lock.tryAcquire({
      deadline,
      purpose: "command",
      sessionId: caller.sessionId,
      maxWaitMs: Math.min(2_000, deadline.remainingMs()),
    })
    if (handle === null) return { kind: "rejected", code: "state_conflict", rejectionCount: 0 }
    try {
      const cwd = await checkWorkingDirectory(this.taskLedger.store.root, caller.cwd)
      if (!cwd.ok) return { kind: "rejected", code: "cwd_mismatch", rejectionCount: 0 }
      const resolved = await this.taskLedger.resolve(caller.sessionId)
      if (resolved.kind !== "scope") {
        return { kind: "rejected", code: "caller_not_current_parent", rejectionCount: 0 }
      }
      if (isTerminal(resolved.value.run)) {
        return { kind: "rejected", code: "terminal_run", rejectionCount: 0 }
      }
      const generation = taskGeneration(resolved.value)
      const identity = runtimeIdentities(resolved.value, generation).find(
        (candidate) => candidate.actualAgentId === parsed.data.agentId,
      )
      if (generation === 0 || identity === undefined) {
        return { kind: "rejected", code: "unowned_worker", rejectionCount: 0 }
      }
      if (!WorkerRoleSchema.safeParse(identity.agentType).success) {
        return { kind: "rejected", code: "unowned_worker_role", rejectionCount: 0 }
      }
      const dispatch = { scope: resolved.value, identity, generation, input: parsed.data }
      return await this.#acceptDispatch(dispatch, deadline, signal)
    } finally {
      await handle.release()
    }
  }

  async #acceptDispatch(
    dispatch: DispatchScope,
    deadline: Deadline,
    signal?: AbortSignal,
  ): Promise<WorkerAcceptanceResult> {
    const rejectionScope = {
      runId: dispatch.scope.run.runId,
      attempt: dispatch.scope.run.progressRevision,
      runRevision: dispatch.scope.run.revision,
      ownerEpoch: dispatch.scope.run.owner.epoch,
      taskGeneration: dispatch.generation,
      actualAgentId: dispatch.identity.actualAgentId,
    }
    const priorRejections = await this.acceptanceLedger.rejectionCount(rejectionScope)
    if (
      dispatch.input.parentDecision === "retry_worker" ||
      dispatch.input.parentDecision === "cancel_dispatch"
    ) {
      return {
        kind: priorRejections === 3 ? "needs_parent_decision" : "rejected",
        code: "parent_declined_acceptance",
        rejectionCount: priorRejections,
      }
    }
    if (priorRejections === 3 && dispatch.input.parentDecision !== "accept_after_review") {
      return { kind: "needs_parent_decision", code: "retry_cap_reached", rejectionCount: 3 }
    }
    if (signal?.aborted) return this.#reject(rejectionScope, deadline, "interrupted")
    const git = await readGitEvidenceBinding(this.taskLedger.store.root)
    if (!git.ok) return this.#reject(rejectionScope, deadline, git.code)
    const evidence = await validateEvidenceBundle(
      this.taskLedger.store.root,
      dispatch.scope.run.runId,
      dispatch.scope.run.progressRevision,
      dispatch.input.receiptPath,
    )
    if (!evidence.ok) return this.#reject(rejectionScope, deadline, evidence.code)
    const bindingError = receiptBindingError(dispatch, evidence.value, git.head)
    if (bindingError !== null) return this.#reject(rejectionScope, deadline, bindingError)
    if (signal?.aborted) return this.#reject(rejectionScope, deadline, "interrupted")
    const finalGit = await readGitEvidenceBinding(this.taskLedger.store.root)
    if (!finalGit.ok) return this.#reject(rejectionScope, deadline, finalGit.code)
    if (finalGit.head !== git.head) return this.#reject(rejectionScope, deadline, "head_changed")
    const receipt = evidence.value.receipt
    const status = await this.acceptanceLedger.accept(
      {
        runId: receipt.runId,
        attempt: receipt.attempt,
        runRevision: receipt.runRevision,
        ownerSessionId: dispatch.scope.run.owner.sessionId,
        ownerEpoch: receipt.ownerEpoch,
        taskGeneration: receipt.taskGeneration,
        workerRole: receipt.workerRole,
        actualAgentId: receipt.actualAgentId,
        actualJobId: receipt.actualJobId,
        captureCommit: receipt.captureCommit,
        receiptPath: evidence.value.receiptFile.relativePath,
        artifactHash: evidence.value.artifactHash,
        artifactPaths: evidence.value.artifacts.map((file) => file.relativePath),
        cleanupReceiptPaths: evidence.value.cleanupReceipts.map((file) => file.relativePath),
        ...(dispatch.input.parentDecision === "accept_after_review"
          ? { parentDecision: dispatch.input.parentDecision }
          : {}),
      },
      evidence.value,
      deadline,
    )
    if (status === "duplicate_receipt") {
      return { kind: "rejected", code: status, rejectionCount: priorRejections }
    }
    return { kind: status, artifactHash: evidence.value.artifactHash }
  }

  async #reject(
    scope: Parameters<WorkerAcceptanceLedger["rejectionCount"]>[0],
    deadline: Deadline,
    code: string,
  ): Promise<WorkerAcceptanceResult> {
    const count = await this.acceptanceLedger.reject(scope, deadline)
    return { kind: count === 3 ? "needs_parent_decision" : "rejected", code, rejectionCount: count }
  }
}
