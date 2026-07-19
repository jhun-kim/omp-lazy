import { type ToolCallId, ToolCallIdSchema } from "../contracts/agent-ids"
import {
  isHubProcessControl,
  type ParsedHubWaitControl,
  type ParsedIrcControl,
  type ParsedJobControl,
  parseHubWaitControl,
  parseIrcControl,
  parseJobControl,
} from "./task-control-parser"
import { type ParsedTaskSpawn, parseTaskSpawn } from "./task-spawn-parser"

const CONTROLLED_TOOL_NAMES = ["task", "job", "irc", "hub"] as const

type ControlledToolName = (typeof CONTROLLED_TOOL_NAMES)[number]
type ParsedJobAuthorization = Extract<ParsedJobControl, { readonly ok: true }>
type ParsedIrcAuthorization = Extract<ParsedIrcControl, { readonly ok: true }>
type ParsedHubWaitAuthorization = Extract<ParsedHubWaitControl, { readonly ok: true }>

export type ImmutableToolAuthorization =
  | { readonly kind: "pass_through" }
  | { readonly kind: "denied"; readonly reason: string }
  | {
      readonly kind: "task"
      readonly toolCallId: ToolCallId
      readonly spawn: ParsedTaskSpawn
    }
  | {
      readonly kind: "job"
      readonly toolCallId: ToolCallId
      readonly control: ParsedJobAuthorization
    }
  | {
      readonly kind: "irc"
      readonly toolCallId: ToolCallId
      readonly control: ParsedIrcAuthorization
    }
  | {
      readonly kind: "hub_wait"
      readonly toolCallId: ToolCallId
      readonly control: ParsedHubWaitAuthorization
    }

export type ImmutableToolAuthorizationRequest = {
  readonly toolName: string
  readonly toolCallId: string
  readonly input: unknown
}

function assertNever(value: never): never {
  throw new Error(`unhandled controlled tool: ${String(value)}`)
}

function controlledToolName(toolName: string): ControlledToolName | null {
  return CONTROLLED_TOOL_NAMES.find((candidate) => candidate === toolName) ?? null
}

function malformedReason(toolName: ControlledToolName): string {
  switch (toolName) {
    case "task":
      return "omp-lazy: malformed task input"
    case "job":
      return "omp-lazy: malformed job control"
    case "irc":
      return "omp-lazy: malformed IRC control"
    case "hub":
      return "omp-lazy: malformed hub control"
    default:
      return assertNever(toolName)
  }
}

export function authorizeImmutableToolCall(
  request: ImmutableToolAuthorizationRequest,
): ImmutableToolAuthorization {
  const toolName = controlledToolName(request.toolName)
  if (toolName === null) return { kind: "pass_through" }

  const toolCallId = ToolCallIdSchema.safeParse(request.toolCallId)
  if (!toolCallId.success) return { kind: "denied", reason: malformedReason(toolName) }

  switch (toolName) {
    case "task": {
      const spawn = parseTaskSpawn(request.input)
      return spawn.ok
        ? { kind: "task", toolCallId: toolCallId.data, spawn: spawn.value }
        : { kind: "denied", reason: malformedReason(toolName) }
    }
    case "job": {
      const control = parseJobControl(request.input)
      return control.ok
        ? { kind: "job", toolCallId: toolCallId.data, control }
        : { kind: "denied", reason: malformedReason(toolName) }
    }
    case "irc": {
      const control = parseIrcControl(request.input)
      return control.ok
        ? { kind: "irc", toolCallId: toolCallId.data, control }
        : { kind: "denied", reason: malformedReason(toolName) }
    }
    case "hub": {
      if (isHubProcessControl(request.input)) return { kind: "pass_through" }
      const wait = parseHubWaitControl(request.input)
      if (wait.ok) return { kind: "hub_wait", toolCallId: toolCallId.data, control: wait }
      const job = parseJobControl(request.input)
      if (job.ok) return { kind: "job", toolCallId: toolCallId.data, control: job }
      const irc = parseIrcControl(request.input)
      return irc.ok
        ? { kind: "irc", toolCallId: toolCallId.data, control: irc }
        : { kind: "denied", reason: malformedReason(toolName) }
    }
    default:
      return assertNever(toolName)
  }
}
