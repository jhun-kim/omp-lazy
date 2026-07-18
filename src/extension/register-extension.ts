import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import { ActivationProvenanceController } from "../activation/provenance-controller"
import { TransactionActivationState } from "../activation/transaction-activation-state"
import type { ActivationStatePort, WorkflowActivationId } from "../activation/types"
import { registerWorkflowCommands } from "../commands/register-workflow-commands"
import {
  CommandStateError,
  DurableWorkflowCommandExecutor,
} from "../commands/workflow-command-handler"
import { createDurableContinuationCoordinator } from "../continuation/durable-continuation"
import { registerSessionStop } from "../continuation/register-session-stop"
import { WorkerResultAcceptance } from "../contracts/worker-result-acceptance"
import { TaskEventLedger } from "../gates/task-event-ledger"
import { registerToolCallDispatcher, resolveCurrentRunScope } from "../gates/tool-call-dispatcher"
import { ToolResultObserver } from "../observers/tool-result-observer"
import { resolveAuthoritativeRoot } from "../state/repo-root"
import { TransactionStore } from "../state/transaction-store"
import { registerWorkerResultTool } from "../tools/register-worker-result-tool"

class ContextualActivationState implements ActivationStatePort {
  constructor(readonly cwdBySession: ReadonlyMap<string, string>) {}

  async isActive(workflow: WorkflowActivationId, sessionId: string): Promise<boolean> {
    const cwd = this.cwdBySession.get(sessionId)
    if (cwd === undefined) return false
    const root = await resolveAuthoritativeRoot({ cwd })
    return root.ok
      ? new TransactionActivationState(new TransactionStore(root.value)).isActive(
          workflow,
          sessionId,
        )
      : false
  }
}

export function registerOmpLazyExtension(api: ExtensionAPI): void {
  const cwdBySession = new Map<string, string>()
  const activation = new ActivationProvenanceController(new ContextualActivationState(cwdBySession))

  api.on("input", async (event, context) => {
    const sessionId = context.sessionManager.getSessionId()
    cwdBySession.set(sessionId, context.cwd)
    await activation.recordInput({ sessionId, source: event.source, text: event.text })
  })

  api.on("before_agent_start", async (event, context) => {
    const sessionId = context.sessionManager.getSessionId()
    cwdBySession.set(sessionId, context.cwd)
    const decision = await activation.consumeBeforeAgentStart({ sessionId, prompt: event.prompt })
    const scope = await resolveCurrentRunScope(context.cwd, sessionId)
    const contextLines: string[] = []
    if (decision.kind === "activate") {
      contextLines.push(`Activate ${decision.workflow} from trusted command ${decision.command}.`)
    }
    if (scope.kind === "conflict") {
      contextLines.push(
        "OMP-lazy workflow state is malformed or ambiguous; guarded calls fail closed.",
      )
    } else if (scope.kind === "current") {
      contextLines.push(
        `Current OMP-lazy ${scope.run.workflow} run ${scope.run.runId} is ${scope.run.payload.status} at revision ${scope.run.revision}.`,
      )
    }
    if (contextLines.length === 0) return undefined
    return {
      message: {
        customType: "omp-lazy-runtime-context",
        content: contextLines.join("\n"),
        display: false,
        details: { activation: decision, scope: scope.kind },
      },
    }
  })

  registerWorkflowCommands(api, {
    execute: async (request) => {
      const root = await resolveAuthoritativeRoot({ cwd: request.cwd })
      if (!root.ok) throw new CommandStateError(root.code)
      await new DurableWorkflowCommandExecutor({
        store: new TransactionStore(root.value),
        suppression: activation,
        sendUserMessage: (message) => api.sendUserMessage(message),
      }).execute(request)
    },
  })

  registerSessionStop(api, createDurableContinuationCoordinator(), activation)
  registerToolCallDispatcher(api)

  api.on("tool_result", async (event, context) => {
    const root = await resolveAuthoritativeRoot({ cwd: context.cwd })
    if (!root.ok) return
    await new ToolResultObserver(new TaskEventLedger(new TransactionStore(root.value))).observe({
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      input: event.input,
      details: event.details,
      isError: event.isError,
      sessionId: context.sessionManager.getSessionId(),
    })
  })

  registerWorkerResultTool(api, {
    accept: async (caller, inputValue, signal) => {
      const root = await resolveAuthoritativeRoot({ cwd: caller.cwd })
      if (!root.ok) return { kind: "rejected", code: root.code, rejectionCount: 0 }
      return new WorkerResultAcceptance(
        new TaskEventLedger(new TransactionStore(root.value)),
      ).accept(caller, inputValue, signal)
    },
  })
}
