import { validateActiveIndex } from "../state/active-index"
import type { WorkflowKind } from "../state/domain"
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
    case "ulw_research":
    case "doctor":
    case "report_bug":
    case "contribute_bug_fix":
      return null
    default:
      return workflow satisfies never
  }
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
}
