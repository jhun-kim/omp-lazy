import type {
  ExtensionContext,
  SessionStopEvent,
  SessionStopEventResult,
} from "@oh-my-pi/pi-coding-agent"
import type { ActivationSuppressionPort } from "../activation/types"
import type { CanonicalRoot } from "../state/domain"
import {
  checkBudget,
  exhaustedCounter,
  incrementCounter,
  readContinuationCounter,
  writeContinuationCounter,
} from "./continuation-budget"
import type { ContinuationCoordinatorPort } from "./continuation-coordinator"
import { createDeadlineFence, type DeadlineFence, type MonotonicClock } from "./deadline-fence"
import { appendSteeringReminder } from "./steering-reminder"

export type ContinuationBudgetPort = {
  readonly resolveRoot: (cwd: string) => Promise<CanonicalRoot | null>
  readonly resolveActiveRunId: (root: CanonicalRoot, sessionId: string) => Promise<string | null>
}

export type SessionStopInput = {
  readonly contextPercent: number | undefined
  readonly contextSessionId: string
  readonly cwd: string
  readonly diagnosticTurnId: number
  readonly leafId: string | null
  readonly sessionId: string
  readonly stopHookActive: boolean
}

export type FenceFactory = () => DeadlineFence

export async function handleSessionStop(
  input: SessionStopInput,
  dependencies: {
    readonly coordinator: ContinuationCoordinatorPort
    readonly suppression: ActivationSuppressionPort
    readonly createFence: FenceFactory
    readonly budget?: ContinuationBudgetPort
  },
): Promise<SessionStopEventResult | undefined> {
  if (
    input.stopHookActive ||
    input.sessionId.trim().length === 0 ||
    input.sessionId !== input.contextSessionId ||
    input.leafId === null ||
    input.leafId.trim().length === 0 ||
    input.contextPercent === undefined ||
    !Number.isFinite(input.contextPercent) ||
    input.contextPercent < 0 ||
    input.contextPercent >= 90
  ) {
    return undefined
  }
  const fence = dependencies.createFence()
  try {
    if (!fence.isValid()) return undefined
    const result = await dependencies.coordinator.handle({
      cwd: input.cwd,
      diagnosticTurnId: input.diagnosticTurnId,
      fence,
      leafId: input.leafId,
      sessionId: input.sessionId,
    })
    if (result.kind === "quiet" || !fence.isValid()) return undefined

    // Budget check: guard against unbounded continuations
    if (dependencies.budget) {
      const root = await dependencies.budget.resolveRoot(input.cwd)
      if (!fence.isValid() || root === null) return undefined
      const runId = await dependencies.budget.resolveActiveRunId(root, input.sessionId)
      if (!fence.isValid()) return undefined
      const effectiveRunId = runId ?? "unknown"
      const counter = await readContinuationCounter(root, input.sessionId)
      if (!fence.isValid()) return undefined
      const budgetResult = checkBudget(counter, effectiveRunId, input.diagnosticTurnId)
      if (!budgetResult.allowed) {
        const updated = exhaustedCounter(
          counter,
          input.sessionId,
          effectiveRunId,
          input.diagnosticTurnId,
        )
        await writeContinuationCounter(root, updated, fence)
        return undefined
      }
      // Increment counter for the continuation we're about to emit
      const updated = incrementCounter(
        counter,
        input.sessionId,
        effectiveRunId,
        input.diagnosticTurnId,
      )
      await writeContinuationCounter(root, updated, fence)
      if (!fence.isValid()) return undefined
    }

    const steeredContext = appendSteeringReminder(result.additionalContext)
    await dependencies.suppression.suppressNext({
      sessionId: input.sessionId,
      text: steeredContext,
      reason: "continuation",
    })
    if (!fence.isValid()) return undefined
    return { continue: true, additionalContext: steeredContext }
  } catch (error) {
    if (error instanceof Error) return undefined
    throw error
  } finally {
    fence.invalidate()
  }
}

type SessionStopHandler = (
  event: SessionStopEvent,
  context: ExtensionContext,
) => Promise<SessionStopEventResult | undefined>

export interface SessionStopRegistrationApi {
  on(event: "session_stop", handler: SessionStopHandler): void
}

export function registerSessionStop(
  api: SessionStopRegistrationApi,
  coordinator: ContinuationCoordinatorPort,
  suppression: ActivationSuppressionPort,
  clock: MonotonicClock = { nowMs: () => performance.now() },
  budget?: ContinuationBudgetPort,
): void {
  api.on("session_stop", async (event, context) => {
    const usage = context.getContextUsage()
    return handleSessionStop(
      {
        contextPercent: usage?.percent,
        contextSessionId: context.sessionManager.getSessionId(),
        cwd: context.cwd,
        diagnosticTurnId: event.turn_id,
        leafId: context.sessionManager.getLeafId(),
        sessionId: event.session_id,
        stopHookActive: event.stop_hook_active,
      },
      {
        coordinator,
        suppression,
        createFence: () => createDeadlineFence(2_000, clock),
        ...(budget !== undefined ? { budget } : {}),
      },
    )
  })
}
