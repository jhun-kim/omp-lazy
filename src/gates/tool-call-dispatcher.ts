import { validateActiveIndex } from "../state/active-index"
import type { AnyRun, CanonicalRoot } from "../state/domain"
import { resolveAuthoritativeRoot } from "../state/repo-root"
import { TransactionStore } from "../state/transaction-store"
import { authorizeImmutableToolCall } from "./immutable-tool-authorization"
import { TaskEventLedger } from "./task-event-ledger"
import { currentTaskSpawnPacketPolicy, TaskSpawnGuard } from "./task-spawn-guard"

export type CurrentRunScope =
  | { readonly kind: "foreign" }
  | { readonly kind: "conflict" }
  | {
      readonly kind: "current"
      readonly root: CanonicalRoot
      readonly store: TransactionStore
      readonly run: AnyRun
    }

export type ToolCallDispatchResult = { readonly block: true; readonly reason: string } | undefined

export type ToolCallDispatcherApi = {
  readonly on: (
    event: "tool_call",
    handler: (
      event: { readonly toolName: string; readonly toolCallId: string; readonly input: unknown },
      context: {
        readonly cwd: string
        readonly sessionManager: { readonly getSessionId: () => string }
      },
    ) => Promise<ToolCallDispatchResult>,
  ) => void
}

function isNonterminal(run: AnyRun): boolean {
  const status = run.payload.status
  switch (status) {
    case "active":
    case "paused":
    case "stuck":
    case "blocked":
    case "needs_user_decision":
    case "review_blocked":
      return true
    case "completed":
    case "cancelled":
    case "failed":
    case "abandoned":
      return false
    default:
      return status satisfies never
  }
}

export async function resolveCurrentRunScope(
  cwd: string,
  sessionId: string,
): Promise<CurrentRunScope> {
  const root = await resolveAuthoritativeRoot({ cwd })
  if (!root.ok) return { kind: "foreign" }
  const store = new TransactionStore(root.value)
  try {
    const index = await store.readIndex()
    if (!validateActiveIndex(index).ok) return { kind: "conflict" }
    const entries = index.entries.filter((entry) => entry.sessionId === sessionId)
    if (entries.length === 0) return { kind: "foreign" }
    if (entries.length !== 1) return { kind: "conflict" }
    const entry = entries[0]
    if (entry === undefined) return { kind: "conflict" }
    const run = await store.readRun(entry.runId)
    if (
      run === null ||
      !isNonterminal(run) ||
      run.workflow !== entry.workflow ||
      run.owner.sessionId !== entry.sessionId ||
      run.owner.epoch !== entry.ownerEpoch ||
      run.revision !== entry.runRevision ||
      run.transactionRevision !== entry.transactionRevision
    ) {
      return { kind: "conflict" }
    }
    return { kind: "current", root: root.value, store, run }
  } catch (error) {
    if (error instanceof Error) return { kind: "conflict" }
    throw error
  }
}

export function registerToolCallDispatcher(api: ToolCallDispatcherApi, maxFanOut = 32): void {
  api.on("tool_call", async (event, context) => {
    const authorization = authorizeImmutableToolCall({
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      input: event.input,
    })
    if (authorization.kind === "pass_through") return undefined

    const sessionId = context.sessionManager.getSessionId()
    const scope = await resolveCurrentRunScope(context.cwd, sessionId)
    if (scope.kind === "foreign") return undefined
    if (scope.kind === "conflict") {
      return { block: true, reason: "omp-lazy: active workflow state conflict" }
    }
    const ledger = new TaskEventLedger(scope.store)
    try {
      const taskScope = await ledger.resolve(sessionId)
      if (
        taskScope.kind !== "scope" ||
        taskScope.value.run.runId !== scope.run.runId ||
        taskScope.value.run.revision !== scope.run.revision ||
        taskScope.value.run.transactionRevision !== scope.run.transactionRevision ||
        taskScope.value.run.owner.sessionId !== sessionId ||
        taskScope.value.run.owner.epoch !== scope.run.owner.epoch
      ) {
        return { block: true, reason: "omp-lazy: active workflow state conflict" }
      }
      return new TaskSpawnGuard(
        ledger,
        maxFanOut,
        currentTaskSpawnPacketPolicy(taskScope.value),
      ).handleAuthorized({
        authorization,
        sessionId,
      })
    } catch (error) {
      if (error instanceof Error) {
        return { block: true, reason: "omp-lazy: active workflow state conflict" }
      }
      throw error
    }
  })
}
