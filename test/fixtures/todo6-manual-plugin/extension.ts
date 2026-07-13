import { appendFile } from "node:fs/promises"
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import type { ActivationSuppressionPort } from "../../../src/activation/types"
import type { ContinuationCoordinatorPort } from "../../../src/continuation/continuation-coordinator"
import {
  registerSessionStop,
  type SessionStopRegistrationApi,
} from "../../../src/continuation/register-session-stop"

const suppression: ActivationSuppressionPort = {
  suppressNext: async () => undefined,
  runCommand: async (_sessionId, operation) => operation(),
}

// biome-ignore lint/style/noDefaultExport: OMP extension factories require a default export.
export default function todo6ManualSurface(api: ExtensionAPI): void {
  const coordinator: ContinuationCoordinatorPort = {
    handle: async (request) => {
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index access for ProcessEnv.
      if (process.env["TODO6_COORDINATOR_ENABLED"] !== "1") return { kind: "quiet" }
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index access for ProcessEnv.
      const observablePath = process.env["TODO6_OBSERVABLE_PATH"]
      if (observablePath !== undefined) {
        await appendFile(
          observablePath,
          `${JSON.stringify({
            leafId: request.leafId,
            sessionId: request.sessionId,
            turnId: request.diagnosticTurnId,
          })}\n`,
        )
      }
      return { kind: "continue", additionalContext: "Continue once from Todo 6 QA." }
    },
  }
  const registrationApi: SessionStopRegistrationApi = {
    on: (_event, handler) => {
      api.on("session_stop", async (event, context) => {
        // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index access for ProcessEnv.
        const rawPath = process.env["TODO6_RAW_OBSERVABLE_PATH"]
        if (rawPath !== undefined) {
          await appendFile(
            rawPath,
            `${JSON.stringify({
              contextPercent: context.getContextUsage()?.percent,
              contextSessionId: context.sessionManager.getSessionId(),
              eventSessionId: event.session_id,
              leafId: context.sessionManager.getLeafId(),
              stopHookActive: event.stop_hook_active,
            })}\n`,
          )
        }
        return handler(event, context)
      })
    },
  }
  registerSessionStop(registrationApi, coordinator, suppression)
}
