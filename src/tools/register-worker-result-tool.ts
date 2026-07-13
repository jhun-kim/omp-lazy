import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent"
import { WorkerAcceptanceInputSchema } from "../contracts/evidence-receipt"
import type {
  WorkerAcceptanceResult,
  WorkerResultAcceptance,
} from "../contracts/worker-result-acceptance"

export const WORKER_RESULT_TOOL_NAME = "omp_lazy_accept_worker_result" as const

export function createWorkerResultTool(
  acceptance: WorkerResultAcceptance,
): ToolDefinition<typeof WorkerAcceptanceInputSchema, WorkerAcceptanceResult> {
  return {
    name: WORKER_RESULT_TOOL_NAME,
    label: "Accept worker evidence",
    description:
      "Parent-only acceptance of a completed omp-lazy worker result after receipt, identity, cleanup, artifact, attempt, and Git binding checks.",
    parameters: WorkerAcceptanceInputSchema,
    approval: "write",
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      const result = await acceptance.accept(
        {
          sessionId: context.sessionManager.getSessionId(),
          cwd: context.cwd,
        },
        params,
        signal,
      )
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      }
    },
  }
}

export function registerWorkerResultTool(
  api: ExtensionAPI,
  acceptance: WorkerResultAcceptance,
): void {
  api.registerTool(createWorkerResultTool(acceptance))
}
