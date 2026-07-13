import { writeFile } from "node:fs/promises"
import { TaskEventLedger } from "../../src/gates/task-event-ledger"
import { TaskSpawnGuard } from "../../src/gates/task-spawn-guard"
import { canonicalComparisonPath } from "../../src/state/paths"
import { TransactionStore } from "../../src/state/transaction-store"

const [rootPath, toolCallId, outputPath] = process.argv.slice(2)
if (rootPath === undefined || toolCallId === undefined || outputPath === undefined) {
  throw new Error("usage: task-reservation-writer <root> <tool-call-id> <output>")
}

const root = { canonicalPath: canonicalComparisonPath(rootPath), displayPath: rootPath }
const guard = new TaskSpawnGuard(new TaskEventLedger(new TransactionStore(root)), 3)
const result = await guard.handle({
  toolName: "task",
  toolCallId,
  input: { context: "shared", tasks: [{ task: "one" }, { task: "two" }] },
  sessionId: "session-a",
})
await writeFile(outputPath, JSON.stringify({ allowed: result === undefined, result }))
