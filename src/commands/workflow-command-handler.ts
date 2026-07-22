import type { ActivationSuppressionPort } from "../activation/types"
import type { TransactionStore } from "../state/transaction-store"
import { CommandSyntaxError, parseWorkflowCommand } from "./command-parser"
import type { WorkflowCommandResult } from "./command-result"
import type { WorkflowCommandExecutor, WorkflowCommandRequest } from "./register-workflow-commands"
import { executeCoordinatorCommand } from "./workflow-command-coordinator"

export class CommandStateError extends Error {
  readonly name = "CommandStateError"
  constructor(readonly code: string) {
    super(code)
  }
}

type CommandRuntime = {
  readonly store: TransactionStore
  readonly suppression: ActivationSuppressionPort
  readonly sendUserMessage: (message: string) => void
  readonly publishResult?: ((result: WorkflowCommandResult) => void) | undefined
}

export class DurableWorkflowCommandExecutor implements WorkflowCommandExecutor {
  constructor(readonly runtime: CommandRuntime) {}

  async execute(request: WorkflowCommandRequest): Promise<void> {
    const parsed = parseWorkflowCommand(request.registration.workflow, request.args)
    if (!parsed.ok) throw new CommandSyntaxError(request.registration.command)
    const coordinated = await executeCoordinatorCommand({
      store: this.runtime.store,
      workflow: request.registration.workflow,
      parsed,
      sessionId: request.sessionId,
      cwd: request.cwd,
      source: request.source,
    })
    if (coordinated !== null) {
      this.runtime.publishResult?.(coordinated)
      return
    }
    const message = `Activate omp-lazy workflow ${request.registration.workflow}: ${request.args}`
    await this.runtime.suppression.suppressNext({
      sessionId: request.sessionId,
      text: message,
      reason: "command",
    })
    await this.runtime.suppression.runCommand(request.sessionId, async () => {
      this.runtime.sendUserMessage(message)
    })
  }
}
