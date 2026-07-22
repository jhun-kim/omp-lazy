import { readGitEvidenceBinding } from "../contracts/git-evidence-binding"
import { TaskEventLedger } from "../gates/task-event-ledger"
import type { AnyRun } from "../state/domain"
import type { TransactionStore } from "../state/transaction-store"
import { TeammodeContract } from "../workflows/teammode-contract"
import { TeammodeStateStore } from "../workflows/teammode-state-store"
import type { ParsedWorkflowCommand } from "./command-parser"
import { commandResult, type WorkflowCommandResult } from "./command-result"
import { consumeTeamReservation, prepareTeamReservation } from "./team-reservation-store"
import { readTeamDefinition } from "./workflow-command-inputs"

type TeamCommandContext = {
  readonly store: TransactionStore
  readonly parsed: Extract<ParsedWorkflowCommand, { readonly ok: true }>
  readonly sessionId: string
  readonly cwd: string
  readonly currentRun: () => Promise<AnyRun | null>
}

function result(
  operation: string,
  status: "PASS" | "BLOCKED",
  values: {
    readonly runId?: string | null
    readonly revision?: number | null
    readonly runStatus?: string | null
    readonly code?: string | null
  } = {},
): WorkflowCommandResult {
  return commandResult({
    status,
    workflow: "teammode",
    operation,
    runId: values.runId ?? null,
    revision: values.revision ?? null,
    runStatus: values.runStatus ?? null,
    code: values.code ?? null,
  })
}

export async function executeTeamCommand(
  context: TeamCommandContext,
): Promise<WorkflowCommandResult> {
  const { operation, words } = context.parsed
  if (operation === "prepare") {
    const run = await context.currentRun()
    if (run === null) return result(operation, "BLOCKED", { code: "missing_target" })
    const definition = await readTeamDefinition(context.store, words[1] ?? "")
    if (!definition.ok) return result(operation, "BLOCKED", { code: definition.code })
    if (definition.value.teamName !== words[0]) {
      return result(operation, "BLOCKED", { code: "task_scope_mismatch" })
    }
    const git = await readGitEvidenceBinding(context.store.root)
    if (!git.ok) return result(operation, "BLOCKED", { code: git.code })
    if (run.schemaVersion !== 2 || run.expectedHead !== git.head) {
      return result(operation, "BLOCKED", { code: "stale_head" })
    }
    const prepared = await prepareTeamReservation({
      store: context.store,
      run,
      definition: definition.value,
      expectedHead: git.head,
    })
    return prepared.ok
      ? result(operation, "PASS", {
          runId: prepared.reservationId,
          revision: run.revision,
          runStatus: "reserved",
        })
      : result(operation, "BLOCKED", { code: prepared.code })
  }
  if (operation === "create") {
    const created = await consumeTeamReservation({
      store: context.store,
      callerSessionId: context.sessionId,
      teamName: words[0] ?? "",
      reservationId: words[1] ?? "",
      readGit: () => readGitEvidenceBinding(context.store.root),
    })
    return created.ok
      ? result(operation, "PASS", {
          runId: created.state?.runId ?? null,
          revision: created.state?.revision ?? null,
          runStatus: created.state?.status ?? "initialized",
        })
      : result(operation, "BLOCKED", { code: created.code })
  }
  const teamName = words[0]
  if (teamName === undefined) return result(operation, "BLOCKED", { code: "missing_target" })
  const contract = new TeammodeContract(new TaskEventLedger(context.store))
  if (operation === "status") {
    const state = await new TeammodeStateStore(context.store).read(teamName)
    if (state === null) return result(operation, "BLOCKED", { code: "missing_target" })
    const run = await context.store.readRun(state.runId)
    if (run === null || run.owner.sessionId !== context.sessionId) {
      return result(operation, "BLOCKED", { code: "owner_mismatch" })
    }
    return result(operation, "PASS", {
      runId: state.runId,
      revision: state.revision,
      runStatus: state.status,
    })
  }
  const caller = {
    sessionId: context.sessionId,
    cwd: context.cwd,
    toolNames: ["task", "hub"],
  }
  const controlled =
    operation === "cancel"
      ? await contract.cancel(caller, teamName)
      : operation === "archive"
        ? await contract.archive(caller, teamName)
        : operation === "delete"
          ? await contract.delete(caller, teamName)
          : await contract.resume(caller, teamName)
  return controlled.ok
    ? result(operation, "PASS", {
        runId: controlled.state?.runId ?? null,
        revision: controlled.state?.revision ?? null,
        runStatus: controlled.status,
      })
    : result(operation, "BLOCKED", { code: controlled.code })
}
