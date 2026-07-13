import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import { z } from "zod"
import { ToolCallIdSchema } from "../contracts/agent-ids"
import { parseIrcControl, parseJobControl } from "./task-control-parser"
import type { TaskEventLedger } from "./task-event-ledger"

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
const guardedTools = new Set(["task", "job", "irc"])

export type TaskSpawnRequest = {
  readonly toolName: string
  readonly toolCallId: string
  readonly input: unknown
  readonly sessionId: string
}

export type TaskSpawnGuardResult = { readonly block: true; readonly reason: string } | undefined

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

export class TaskSpawnGuard {
  constructor(
    readonly ledger: TaskEventLedger,
    readonly maxFanOut: number,
  ) {}

  async handle(request: TaskSpawnRequest): Promise<TaskSpawnGuardResult> {
    if (!guardedTools.has(request.toolName)) return undefined
    try {
      const resolved = await this.ledger.resolve(request.sessionId)
      if (resolved.kind === "none") return undefined
      if (resolved.kind === "conflict") {
        return { block: true, reason: "omp-lazy: task state conflict" }
      }
      if (request.toolName === "job") return this.#handleJob(request)
      if (request.toolName === "irc") return this.#handleIrc(request)
      if (!Number.isSafeInteger(this.maxFanOut) || this.maxFanOut < 1) {
        return { block: true, reason: "omp-lazy: invalid fan-out policy" }
      }
      const parsedCallId = ToolCallIdSchema.safeParse(request.toolCallId)
      const parsedSpawn = parseTaskSpawn(request.input)
      if (!parsedCallId.success || !parsedSpawn.ok) {
        return { block: true, reason: "omp-lazy: malformed task input" }
      }
      const committed = await this.ledger.reserve(
        request.sessionId,
        {
          kind: "task_reserved",
          toolCallId: parsedCallId.data,
          itemCount: parsedSpawn.value.itemCount,
          requests: parsedSpawn.value.requests,
        },
        this.maxFanOut,
      )
      if (committed.kind !== "scope") {
        return { block: true, reason: "omp-lazy: reservation conflict" }
      }
      if (committed.value === "limit") {
        return { block: true, reason: "omp-lazy: fan-out limit exceeded" }
      }
      return committed.value === "fact_conflict"
        ? { block: true, reason: "omp-lazy: reservation conflict" }
        : undefined
    } catch (error) {
      if (error instanceof Error) {
        return { block: true, reason: "omp-lazy: task state conflict" }
      }
      throw error
    }
  }

  async #handleJob(request: TaskSpawnRequest): Promise<TaskSpawnGuardResult> {
    const toolCallId = ToolCallIdSchema.safeParse(request.toolCallId)
    const control = parseJobControl(request.input)
    if (!toolCallId.success || !control.ok) {
      return { block: true, reason: "omp-lazy: malformed job control" }
    }
    const authorized = await this.ledger.authorize(request.sessionId, {
      toolCallId: toolCallId.data,
      control: control.control,
      inputKey: control.inputKey,
      targets: control.targets,
    })
    if (authorized.kind !== "scope") {
      return { block: true, reason: "omp-lazy: task state conflict" }
    }
    if (
      authorized.value === "unowned" ||
      (authorized.value === "no_generation" && control.targets.length > 0)
    ) {
      return { block: true, reason: "omp-lazy: unowned job" }
    }
    return undefined
  }

  async #handleIrc(request: TaskSpawnRequest): Promise<TaskSpawnGuardResult> {
    const toolCallId = ToolCallIdSchema.safeParse(request.toolCallId)
    const control = parseIrcControl(request.input)
    if (!toolCallId.success || !control.ok) {
      return { block: true, reason: "omp-lazy: malformed IRC control" }
    }
    if (control.kind === "passive" && control.targets.length === 0) return undefined
    const authorized = await this.ledger.authorize(request.sessionId, {
      toolCallId: toolCallId.data,
      control: control.kind === "send" ? "irc_send" : "irc_target",
      inputKey: control.inputKey,
      targets: control.targets,
    })
    return authorized.kind === "scope" && authorized.value === "authorized"
      ? undefined
      : { block: true, reason: "omp-lazy: unowned agent" }
  }
}

export function registerTaskSpawnGuard(api: Pick<ExtensionAPI, "on">, guard: TaskSpawnGuard): void {
  api.on("tool_call", async (event, context) =>
    guard.handle({
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      input: event.input,
      sessionId: context.sessionManager.getSessionId(),
    }),
  )
}
