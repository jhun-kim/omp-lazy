import type { ActiveIndex, PersistedStateEvent } from "./domain"

export function persistedEventForIndex(
  index: ActiveIndex,
  event: PersistedStateEvent,
): PersistedStateEvent {
  if (index.schemaVersion === 1 || event.schemaVersion === 2) return event
  const mutation =
    event.mutation.kind === "run_created" && event.mutation.run.schemaVersion === 1
      ? {
          ...event.mutation,
          run: {
            ...event.mutation.run,
            schemaVersion: 2 as const,
            packetHash: null,
            expectedHead: null,
          },
        }
      : event.mutation
  const taskGeneration =
    event.kind === "plan_reconciled" ||
    event.kind === "criterion_settled" ||
    event.kind === "task_evidence_accepted" ||
    event.kind === "workflow_terminal" ||
    event.kind === "goal_cycle_started" ||
    event.kind === "criterion_failure_recorded"
      ? 1
      : null
  return {
    ...event,
    schemaVersion: 2,
    expected: { ...event.expected, expectedHead: null, taskGeneration },
    mutation,
    legacyHeadUnbound: false,
  }
}
