import { durableWorkflowKind } from "../activation/transaction-activation-state"
import type { ActivationSuppressionPort } from "../activation/types"
import type { AnyRun, StateEvent, StateMutation } from "../state/domain"
import { newRunId } from "../state/domain"
import { deadlineAfter } from "../state/repo-lock"
import type { TransactionStore } from "../state/transaction-store"
import { type ControlCommand, reduceWorkflowControl } from "../workflows/workflow-control"
import { CommandSyntaxError, parseWorkflowCommand } from "./command-parser"
import type { WorkflowCommandExecutor, WorkflowCommandRequest } from "./register-workflow-commands"

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
}

type ControlMutation = Extract<
  StateMutation,
  { readonly kind: "workflow_controlled" | "owner_adopted" }
>

function controlMutation(operation: string, sessionId: string): ControlMutation | null {
  if (operation === "pause" || operation === "resume" || operation === "cancel") {
    return { kind: "workflow_controlled", control: operation }
  }
  return operation === "adopt" ? { kind: "owner_adopted", sessionId } : null
}

function eventFor(run: AnyRun, sequence: number, mutation: StateMutation): StateEvent {
  return {
    schemaVersion: 1,
    eventId: newRunId(),
    sequence,
    runId: run.runId,
    workflow: run.workflow,
    kind: mutation.kind,
    expected: {
      indexRevision: sequence - 1,
      runRevision: run.revision,
      ownerSessionId: run.owner.sessionId,
      ownerEpoch: run.owner.epoch,
    },
    mutation,
    at: new Date().toISOString(),
  }
}

export class DurableWorkflowCommandExecutor implements WorkflowCommandExecutor {
  constructor(readonly runtime: CommandRuntime) {}

  async execute(request: WorkflowCommandRequest): Promise<void> {
    const parsed = parseWorkflowCommand(request.registration.workflow, request.args)
    if (!parsed.ok) throw new CommandSyntaxError(request.registration.command)
    const mutation = controlMutation(parsed.operation, request.sessionId)
    const workflow = durableWorkflowKind(request.registration.workflow)
    if (mutation !== null && workflow !== null) {
      const index = await this.runtime.store.readIndex()
      const targetRunId = parsed.words[0]
      const entry = index.entries.find((candidate) => {
        if (candidate.workflow !== workflow) return false
        return targetRunId === undefined
          ? candidate.sessionId === request.sessionId
          : candidate.runId === targetRunId
      })
      const run = entry === undefined ? null : await this.runtime.store.readRun(entry.runId)
      if (run === null || run.workflow !== workflow) throw new CommandStateError("missing_target")
      const command: ControlCommand =
        mutation.kind === "owner_adopted"
          ? { kind: "adopt", sessionId: request.sessionId, expectedEpoch: run.owner.epoch }
          : {
              kind: mutation.control,
              sessionId: request.sessionId,
              expectedEpoch: run.owner.epoch,
            }
      const reduced =
        run.workflow === "start_work"
          ? reduceWorkflowControl(run, command)
          : reduceWorkflowControl(run, command)
      if (!reduced.ok) throw new CommandStateError(reduced.code)
      const committed = await this.runtime.store.commit(
        eventFor(run, index.revision + 1, mutation),
        {
          deadline: deadlineAfter(2_000),
        },
      )
      if (!committed.ok) throw new CommandStateError(committed.code)
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
