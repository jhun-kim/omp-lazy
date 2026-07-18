import { z } from "zod"

const nonempty = z.string().trim().min(1)
const taskItemSchema = z
  .object({
    name: nonempty.optional(),
    agent: nonempty.optional(),
    task: nonempty,
    isolated: z.boolean().optional(),
  })
  .strict()
const flatTaskSchema = taskItemSchema
const batchTaskSchema = z
  .object({
    context: z.string(),
    tasks: z.array(taskItemSchema).min(1),
  })
  .strict()

export type ParsedTaskSpawn = {
  readonly itemCount: number
  readonly requests: readonly {
    readonly itemIndex: number
    readonly requestedName: string | null
    readonly agentType: string | null
  }[]
}

export type TaskParseResult =
  | { readonly ok: true; readonly value: ParsedTaskSpawn }
  | { readonly ok: false; readonly code: "malformed_task_input" }

function taskRequest(
  item: z.infer<typeof taskItemSchema>,
  itemIndex: number,
): ParsedTaskSpawn["requests"][number] {
  return {
    itemIndex,
    requestedName: item.name ?? null,
    agentType: item.agent ?? null,
  }
}

export function parseTaskSpawn(input: unknown): TaskParseResult {
  const flat = flatTaskSchema.safeParse(input)
  if (flat.success) {
    return { ok: true, value: { itemCount: 1, requests: [taskRequest(flat.data, 0)] } }
  }
  const batch = batchTaskSchema.safeParse(input)
  if (!batch.success) return { ok: false, code: "malformed_task_input" }
  return {
    ok: true,
    value: {
      itemCount: batch.data.tasks.length,
      requests: batch.data.tasks.map(taskRequest),
    },
  }
}
