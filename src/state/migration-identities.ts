import { z } from "zod"
import { taskLedgerSchema } from "../gates/task-ledger-codec"

const WorkerRoleSchema = z.enum([
  "omp-lazy-worker-low",
  "omp-lazy-worker-medium",
  "omp-lazy-worker-high",
])

export type TaskIdentity = {
  readonly runId: string
  readonly taskId: string
  readonly role: z.infer<typeof WorkerRoleSchema>
  readonly agentId: string
}

export function taskIdentities(value: unknown): readonly TaskIdentity[] | null {
  const parsed = taskLedgerSchema.safeParse(value)
  if (!parsed.success) return null
  const reservations = new Map<
    string,
    Map<number, { readonly taskId: string; readonly role: string }>
  >()
  const bindings = new Map<
    string,
    readonly { readonly itemIndex: number; readonly actualAgentId: string }[]
  >()
  for (const entry of parsed.data.entries) {
    switch (entry.fact.kind) {
      case "task_reserved":
        reservations.set(
          entry.fact.toolCallId,
          new Map(
            entry.fact.requests.map((request) => [
              request.itemIndex,
              { taskId: request.requestedName ?? "", role: request.agentType ?? "" },
            ]),
          ),
        )
        break
      case "task_identities_bound":
        bindings.set(entry.fact.toolCallId, entry.fact.bindings)
        break
      case "task_control_authorized":
      case "task_receipt_observed":
      case "async_capability_observed":
        break
      default:
        return entry.fact satisfies never
    }
  }
  const identities: TaskIdentity[] = []
  for (const [toolCallId, values] of bindings) {
    const requests = reservations.get(toolCallId)
    if (requests === undefined) return null
    for (const binding of values) {
      const request = requests.get(binding.itemIndex)
      const role = WorkerRoleSchema.safeParse(request?.role)
      if (request === undefined || request.taskId.length === 0 || !role.success) return null
      identities.push({
        runId: parsed.data.runId,
        taskId: request.taskId,
        role: role.data,
        agentId: binding.actualAgentId,
      })
    }
  }
  return identities
}
