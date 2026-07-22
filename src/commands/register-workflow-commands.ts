import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import { COMMAND_REGISTRATIONS, type CommandRegistration } from "./command-definitions"

export type WorkflowCommandRequest = {
  readonly registration: CommandRegistration
  readonly args: string
  readonly sessionId: string
  readonly cwd: string
  readonly source?: "registered_command" | "extension" | undefined
}

export interface WorkflowCommandExecutor {
  execute(request: WorkflowCommandRequest): Promise<void>
}

type CommandRegistrationApi = Pick<ExtensionAPI, "registerCommand">

export function registerWorkflowCommands(
  api: CommandRegistrationApi,
  executor: WorkflowCommandExecutor,
): void {
  for (const registration of COMMAND_REGISTRATIONS) {
    api.registerCommand(registration.command.slice(1), {
      description: registration.definition.description,
      handler: async (args, context) => {
        await executor.execute({
          registration,
          args,
          sessionId: context.sessionManager.getSessionId(),
          cwd: context.cwd,
          source: "registered_command",
        })
      },
    })
  }
}

type RegisteredCommandMap = ReadonlyMap<string, { readonly name: string }>

export type CommandCollisionDiagnostic = {
  readonly status: "PASS" | "FAIL"
  readonly collisions: readonly string[]
}

export function diagnoseCommandCollisions(
  extensionInventories: readonly RegisteredCommandMap[],
  builtinNames: readonly string[],
): CommandCollisionDiagnostic {
  const builtins = new Set(builtinNames)
  const collisions: string[] = []
  for (const registration of COMMAND_REGISTRATIONS) {
    const name = registration.command.slice(1)
    const owners = extensionInventories.filter((inventory) => inventory.has(name)).length
    if (builtins.has(name)) collisions.push(`${registration.command}:builtin`)
    if (owners === 0) collisions.push(`${registration.command}:missing`)
    if (owners > 1) collisions.push(`${registration.command}:extension:${owners}`)
  }
  return { status: collisions.length === 0 ? "PASS" : "FAIL", collisions }
}
