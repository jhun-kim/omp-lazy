import type { WorkflowCommandResult } from "./command-result"
import { approvePlan } from "./workflow-command-inputs"
import type { CommandContext } from "./workflow-command-runtime"
import { result } from "./workflow-command-runtime"
import { executeStartWorkCommand } from "./workflow-command-start"
import { executeTeamCommand } from "./workflow-command-team"
import { executeUlwCommand } from "./workflow-command-ulw"

export async function executeCoordinatorCommand(
  context: CommandContext,
): Promise<WorkflowCommandResult | null> {
  if (context.source === "extension") {
    return result(context, "BLOCKED", { code: "extension_origin_rejected" })
  }
  if (
    context.workflow === "ulw_plan" ||
    context.workflow === "start_work" ||
    context.workflow === "ulw_loop" ||
    context.workflow === "teammode"
  ) {
    await context.store.initializeLifecycle()
  }
  if (context.workflow === "ulw_plan" && context.parsed.operation === "approve") {
    const approved = await approvePlan({
      store: context.store,
      sessionId: context.sessionId,
      path: context.parsed.words[0] ?? "",
      claimedHash: context.parsed.words[1] ?? "",
    })
    return approved.ok
      ? result(context, "PASS", { revision: 1, runStatus: "approved" })
      : result(context, "BLOCKED", { code: approved.code })
  }
  if (context.workflow === "start_work") return executeStartWorkCommand(context)
  if (context.workflow === "ulw_loop") return executeUlwCommand(context)
  if (context.workflow === "teammode") {
    return executeTeamCommand({
      store: context.store,
      parsed: context.parsed,
      sessionId: context.sessionId,
      cwd: context.cwd,
      currentRun: async () => {
        const index = await context.store.readIndex()
        const entries = index.entries.filter((entry) => entry.sessionId === context.sessionId)
        if (entries.length !== 1) return null
        const entry = entries[0]
        return entry === undefined ? null : context.store.readRun(entry.runId)
      },
    })
  }
  return null
}
