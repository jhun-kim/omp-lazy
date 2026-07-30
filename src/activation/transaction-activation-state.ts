import { readFile } from "node:fs/promises"
import { validateActiveIndex } from "../state/active-index"
import { atomicReplace } from "../state/atomic-file"
import type { WorkflowKind } from "../state/domain"
import { directiveActivationPath, ensureStatePathContained } from "../state/paths"
import { deadlineAfter } from "../state/repo-lock"
import type { TransactionStore } from "../state/transaction-store"
import type { ActivationStatePort, WorkflowActivationId } from "./types"

export function durableWorkflowKind(workflow: WorkflowActivationId): WorkflowKind | null {
  switch (workflow) {
    case "start_work":
      return "start_work"
    case "ulw_loop":
      return "ulw_loop"
    case "teammode":
    case "ultrawork":
    case "ulw_plan":
    case "ulw_deliver":
    case "ulw_research":
    case "doctor":
    case "report_bug":
    case "contribute_bug_fix":
      return null
    default:
      return workflow satisfies never
  }
}

/**
 * Schema for the durable directive-activation record.
 * Written to `directive-activations/<sessionId>.json`.
 */
export type DirectiveActivationRecord = {
  readonly schemaVersion: 2
  readonly sessionId: string
  readonly workflow: WorkflowActivationId
  readonly runId: string | null
  readonly activatedAt: string
}

export class TransactionActivationState implements ActivationStatePort {
  constructor(readonly store: TransactionStore) {}

  async isActive(workflow: WorkflowActivationId, sessionId: string): Promise<boolean> {
    const durable = durableWorkflowKind(workflow)
    if (durable === null) return false
    try {
      const index = await this.store.readIndex()
      if (!validateActiveIndex(index).ok) return true
      return index.entries.some(
        (entry) => entry.workflow === durable && entry.sessionId === sessionId,
      )
    } catch (error) {
      if (error instanceof Error) return true
      throw error
    }
  }

  /**
   * Checks if the given workflow was already activated in this session for the given run.
   * Returns true if activation should be suppressed (already injected for this run).
   *
   * On corrupted or unreadable records, returns false (allows fresh activation)
   * to avoid permanent lockout. The record will be overwritten on next activation.
   *
   * When currentRunId is null but a record exists with a non-null runId, the run state
   * is indeterminate. We suppress conservatively to avoid duplicate injection. A new run
   * will write a fresh index entry and resolve the ambiguity.
   */
  async isDirectiveAlreadyActivated(
    sessionId: string,
    workflow: WorkflowActivationId,
    currentRunId: string | null,
  ): Promise<boolean> {
    const record = await this.readDirectiveActivation(sessionId)
    if (record === null) return false
    // Different workflow = not yet activated for this workflow
    if (record.workflow !== workflow) return false
    // Same run id (including both null) = same context, suppress
    if (record.runId === currentRunId) return true
    // currentRunId is null but record has a runId = indeterminate state
    // Be conservative: suppress to avoid duplicate injection
    if (currentRunId === null && record.runId !== null) return true
    // Different known run id = new run, allow re-injection
    return false
  }

  /**
   * Reads the durable directive-activation record for a session.
   * Returns null on missing, corrupted, or unreadable records.
   */
  async readDirectiveActivation(sessionId: string): Promise<DirectiveActivationRecord | null> {
    try {
      const path = directiveActivationPath(this.store.root, sessionId)
      await ensureStatePathContained(this.store.root, path)
      const bytes = await readFile(path, "utf8")
      const value = JSON.parse(bytes) as {
        schemaVersion?: unknown
        sessionId?: unknown
        workflow?: unknown
        runId?: unknown
        activatedAt?: unknown
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) return null
      if (value.schemaVersion !== 2 && value.schemaVersion !== 1) return null
      // Accept both v1 (from migration) and v2 records
      return {
        schemaVersion: 2,
        sessionId: typeof value.sessionId === "string" ? value.sessionId : sessionId,
        workflow: (value.workflow as WorkflowActivationId) ?? "ultrawork",
        runId: typeof value.runId === "string" ? value.runId : null,
        activatedAt: typeof value.activatedAt === "string" ? value.activatedAt : "",
      }
    } catch {
      // Missing file (ENOENT), corrupted JSON, path escape → treat as no record
      return null
    }
  }

  /**
   * Persists the directive-activation record durably.
   * On write failure, the error is swallowed — the caller proceeds with activation
   * and the next call to isDirectiveAlreadyActivated will see no record.
   */
  async recordDirectiveActivation(
    sessionId: string,
    workflow: WorkflowActivationId,
    runId: string | null,
  ): Promise<void> {
    try {
      const path = directiveActivationPath(this.store.root, sessionId)
      const record: DirectiveActivationRecord = {
        schemaVersion: 2,
        sessionId,
        workflow,
        runId,
        activatedAt: new Date().toISOString(),
      }
      await atomicReplace(path, JSON.stringify(record), {
        deadline: deadlineAfter(5_000),
        guard: this.store.guard,
      })
    } catch {
      // Write failure is non-fatal: activation proceeds, idempotency degrades gracefully
    }
  }

  /**
   * Clears the directive-activation record for a session.
   * Used when an explicit command invocation should allow re-injection.
   */
  async clearDirectiveActivation(sessionId: string): Promise<void> {
    try {
      const { rm } = await import("node:fs/promises")
      const path = directiveActivationPath(this.store.root, sessionId)
      await rm(path, { force: true })
    } catch {
      // Non-fatal
    }
  }

  /**
   * Resolves the current active run id for a session, or null if no run is active.
   * Reads the index without triggering migration preflight to avoid cascading failures
   * when other record kinds are corrupted.
   */
  async currentRunId(sessionId: string): Promise<string | null> {
    try {
      const index = await this.store.readIndex(false)
      if (!validateActiveIndex(index).ok) return null
      const entry = index.entries.find((e) => e.sessionId === sessionId)
      return entry?.runId ?? null
    } catch {
      return null
    }
  }
}
