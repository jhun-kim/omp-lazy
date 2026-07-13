import type { AgentId, JobId, ToolCallId } from "../contracts/agent-ids"
import { runtimeIdValue } from "../contracts/agent-ids"
import type { TaskFact } from "./task-ledger-codec"
import { runtimeIdentities, taskAuthorization, taskGeneration } from "./task-ledger-view"
import type { TaskLedgerTransaction, TaskSidecarStore } from "./task-sidecar-store"

export type TaskJobSnapshot = {
  readonly id: JobId
  readonly type: "bash" | "task"
  readonly status: "running" | "completed" | "failed" | "cancelled"
}

export type TaskCancelReceipt = {
  readonly id: JobId
  readonly status: "cancelled" | "not_found" | "already_completed"
}

export type TaskIrcReceipt = {
  readonly to: AgentId
  readonly outcome: "injected" | "woken" | "revived" | "failed"
}

export type ReceiptWriteStatus =
  | "recorded"
  | "uncorrelated"
  | "stale_generation"
  | "identity_mapping_incomplete"
  | "receipt_missing"

function matchingAuthorization(
  toolCallId: ToolCallId,
  inputKey: string,
  control: "job_snapshot" | "job_cancel" | "irc_send",
  scope: Parameters<typeof taskAuthorization>[0],
) {
  const authorization = taskAuthorization(scope, toolCallId)
  if (
    authorization === undefined ||
    authorization.control !== control ||
    authorization.inputKey !== inputKey
  ) {
    return { kind: "uncorrelated" } as const
  }
  if (authorization.taskGeneration !== taskGeneration(scope)) {
    return { kind: "stale_generation" } as const
  }
  return { kind: "matched", authorization } as const
}

export async function recordJobSnapshot(
  sidecar: TaskSidecarStore,
  sessionId: string,
  toolCallId: ToolCallId,
  inputKey: string,
  jobs: readonly TaskJobSnapshot[],
): Promise<TaskLedgerTransaction<ReceiptWriteStatus>> {
  return sidecar.transact(sessionId, (scope) => {
    const matched = matchingAuthorization(toolCallId, inputKey, "job_snapshot", scope)
    if (matched.kind !== "matched") return { kind: "return", value: matched.kind }
    const identities = runtimeIdentities(scope, matched.authorization.taskGeneration)
    const expected = new Set(identities.map((identity) => runtimeIdValue(identity.actualAgentId)))
    const taskJobs = jobs.filter((job) => job.type === "task")
    const returned = new Set(taskJobs.map((job) => runtimeIdValue(job.id)))
    const complete =
      expected.size > 0 &&
      returned.size === taskJobs.length &&
      returned.size === expected.size &&
      [...expected].every((id) => returned.has(id))
    const generation = matched.authorization.taskGeneration
    if (!complete) {
      return {
        kind: "append",
        facts: [
          {
            kind: "async_capability_observed",
            toolCallId,
            taskGeneration: generation,
            status: "blocked",
            reason: "identity_mapping_incomplete",
          },
        ],
        value: "identity_mapping_incomplete",
      }
    }
    const facts: TaskFact[] = taskJobs.map((job) => ({
      kind: "task_receipt_observed",
      toolCallId,
      receipt: { kind: "job", jobId: job.id, status: job.status },
    }))
    facts.push({
      kind: "async_capability_observed",
      toolCallId,
      taskGeneration: generation,
      status: "proven",
      reason: "matching_job_snapshot",
    })
    return { kind: "append", facts, value: "recorded" }
  })
}

export async function recordCancellation(
  sidecar: TaskSidecarStore,
  sessionId: string,
  toolCallId: ToolCallId,
  inputKey: string,
  cancelled: readonly TaskCancelReceipt[],
): Promise<TaskLedgerTransaction<ReceiptWriteStatus>> {
  return sidecar.transact(sessionId, (scope) => {
    const matched = matchingAuthorization(toolCallId, inputKey, "job_cancel", scope)
    if (matched.kind !== "matched") return { kind: "return", value: matched.kind }
    const receipts = matched.authorization.targets.map((target) =>
      cancelled.find(
        (receipt) => runtimeIdValue(receipt.id) === target && receipt.status === "cancelled",
      ),
    )
    if (receipts.some((receipt) => receipt === undefined)) {
      return { kind: "return", value: "receipt_missing" }
    }
    const facts: TaskFact[] = receipts.flatMap((receipt) =>
      receipt === undefined
        ? []
        : [
            {
              kind: "task_receipt_observed",
              toolCallId,
              receipt: { kind: "job_cancel", jobId: receipt.id, status: "cancelled" },
            },
          ],
    )
    return { kind: "append", facts, value: "recorded" }
  })
}

export async function recordIrcReceipts(
  sidecar: TaskSidecarStore,
  sessionId: string,
  toolCallId: ToolCallId,
  inputKey: string,
  receipts: readonly TaskIrcReceipt[],
): Promise<TaskLedgerTransaction<ReceiptWriteStatus>> {
  return sidecar.transact(sessionId, (scope) => {
    const matched = matchingAuthorization(toolCallId, inputKey, "irc_send", scope)
    if (matched.kind !== "matched") return { kind: "return", value: matched.kind }
    const expected = new Set(matched.authorization.targets)
    const matching = receipts.filter((receipt) => expected.has(runtimeIdValue(receipt.to)))
    if (matching.length !== expected.size || receipts.length !== matching.length) {
      return { kind: "return", value: "receipt_missing" }
    }
    return {
      kind: "append",
      facts: matching.map((receipt) => ({
        kind: "task_receipt_observed",
        toolCallId,
        receipt: { kind: "irc", agentId: receipt.to, outcome: receipt.outcome },
      })),
      value: "recorded",
    }
  })
}
