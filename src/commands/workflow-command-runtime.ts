import { createHash } from "node:crypto"
import type {
  AnyRun,
  PersistedStateEvent,
  StateEventV2,
  StateMutation,
  WorkflowKind,
} from "../state/domain"
import { newRunId, UuidSchema } from "../state/domain"
import { deadlineAfter } from "../state/repo-lock"
import type { TransactionResult, TransactionStore } from "../state/transaction-store"
import { type ControlCommand, reduceWorkflowControl } from "../workflows/workflow-control"
import type { ParsedWorkflowCommand } from "./command-parser"
import { commandResult, type WorkflowCommandResult } from "./command-result"

export type ParsedCommand = Extract<ParsedWorkflowCommand, { readonly ok: true }>
export type CommandContext = {
  readonly store: TransactionStore
  readonly workflow: string
  readonly parsed: ParsedCommand
  readonly sessionId: string
  readonly cwd: string
  readonly source?: "registered_command" | "extension" | undefined
}
export type RunLookup =
  | { readonly ok: true; readonly run: AnyRun }
  | { readonly ok: false; readonly code: string }

export function result(
  context: Pick<CommandContext, "workflow" | "parsed">,
  status: "PASS" | "BLOCKED",
  values: {
    readonly run?: AnyRun | null
    readonly runId?: string | null
    readonly revision?: number | null
    readonly runStatus?: string | null
    readonly code?: string | null
  } = {},
): WorkflowCommandResult {
  return commandResult({
    status,
    workflow: context.workflow,
    operation: context.parsed.operation,
    runId: values.run?.runId ?? values.runId ?? null,
    revision: values.run?.revision ?? values.revision ?? null,
    runStatus: values.run?.payload.status ?? values.runStatus ?? null,
    code: values.code ?? null,
  })
}

export function deterministicEventId(key: string): StateEventV2["eventId"] {
  const hash = createHash("sha256").update(key).digest("hex")
  return UuidSchema.parse(
    `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
  )
}

export async function lookupRun(input: {
  readonly store: TransactionStore
  readonly workflow: WorkflowKind
  readonly sessionId: string
  readonly targetRunId?: string | undefined
  readonly adoption?: boolean | undefined
}): Promise<RunLookup> {
  const { store, workflow, sessionId, targetRunId, adoption = false } = input
  if (targetRunId !== undefined) {
    const run = await store.readRun(targetRunId)
    if (run === null || run.workflow !== workflow) return { ok: false, code: "missing_target" }
    if (!adoption && run.owner.sessionId !== sessionId) return { ok: false, code: "owner_mismatch" }
    return { ok: true, run }
  }
  const index = await store.readIndex()
  const entries = index.entries.filter(
    (entry) => entry.workflow === workflow && entry.sessionId === sessionId,
  )
  if (entries.length === 0) return { ok: false, code: "missing_target" }
  if (entries.length !== 1) return { ok: false, code: "ambiguous_target" }
  const entry = entries[0]
  if (entry === undefined) return { ok: false, code: "missing_target" }
  const run = await store.readRun(entry.runId)
  return run === null ? { ok: false, code: "missing_target" } : { ok: true, run }
}

export function createEvent(indexRevision: number, run: AnyRun): StateEventV2 {
  return {
    schemaVersion: 2,
    eventId: newRunId(),
    sequence: indexRevision + 1,
    runId: run.runId,
    workflow: run.workflow,
    kind: "run_created",
    expected: {
      indexRevision,
      runRevision: null,
      ownerSessionId: null,
      ownerEpoch: null,
      expectedHead: null,
      taskGeneration: null,
    },
    mutation: { kind: "run_created", run },
    legacyHeadUnbound: false,
    at: run.createdAt,
  }
}

export async function mutationEvent(input: {
  readonly store: TransactionStore
  readonly run: AnyRun
  readonly mutation: Exclude<StateMutation, { readonly kind: "run_created" }>
  readonly expectedHead: string | null
  readonly taskGeneration: number | null
  readonly idempotencyKey?: string | undefined
}): Promise<StateEventV2> {
  const { store, run, mutation, expectedHead, taskGeneration, idempotencyKey } = input
  const eventId =
    idempotencyKey === undefined
      ? newRunId()
      : deterministicEventId(`${run.runId}\u0000${mutation.kind}\u0000${idempotencyKey}`)
  const existing = idempotencyKey === undefined ? null : await store.readEvent(eventId)
  const index = await store.readIndex()
  const expected =
    existing?.schemaVersion === 2
      ? existing.expected
      : {
          indexRevision: index.revision,
          runRevision: run.revision,
          ownerSessionId: run.owner.sessionId,
          ownerEpoch: run.owner.epoch,
          expectedHead,
          taskGeneration,
        }
  return {
    schemaVersion: 2,
    eventId,
    sequence: existing?.sequence ?? index.revision + 1,
    runId: run.runId,
    workflow: run.workflow,
    kind: mutation.kind,
    expected,
    mutation,
    legacyHeadUnbound: false,
    at: existing?.at ?? new Date().toISOString(),
  }
}

export function commitMutation(
  store: TransactionStore,
  event: PersistedStateEvent,
): Promise<TransactionResult> {
  return store.commit(event, { deadline: deadlineAfter(2_000) })
}

export async function control(
  context: CommandContext,
  workflow: WorkflowKind,
): Promise<WorkflowCommandResult> {
  const adoption = context.parsed.operation === "adopt"
  const found = await lookupRun({
    store: context.store,
    workflow,
    sessionId: context.sessionId,
    targetRunId: context.parsed.words[0],
    adoption,
  })
  if (!found.ok) return result(context, "BLOCKED", { code: found.code })
  const controlKind =
    context.parsed.operation === "pause" || context.parsed.operation === "cancel"
      ? context.parsed.operation
      : "resume"
  const command: ControlCommand = adoption
    ? { kind: "adopt", sessionId: context.sessionId, expectedEpoch: found.run.owner.epoch }
    : { kind: controlKind, sessionId: context.sessionId, expectedEpoch: found.run.owner.epoch }
  const reduced =
    found.run.workflow === "start_work"
      ? reduceWorkflowControl(found.run, command)
      : reduceWorkflowControl(found.run, command)
  if (!reduced.ok) return result(context, "BLOCKED", { code: reduced.code })
  const mutation: Exclude<StateMutation, { readonly kind: "run_created" }> = adoption
    ? { kind: "owner_adopted", sessionId: context.sessionId }
    : { kind: "workflow_controlled", control: controlKind }
  const committed = await commitMutation(
    context.store,
    await mutationEvent({
      store: context.store,
      run: found.run,
      mutation,
      expectedHead: null,
      taskGeneration: null,
    }),
  )
  return committed.ok
    ? result(context, "PASS", { run: committed.run })
    : result(context, "BLOCKED", { code: committed.code })
}
