import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import { WorkerResultAcceptance } from "../../../src/contracts/worker-result-acceptance"
import { TaskEventLedger } from "../../../src/gates/task-event-ledger"
import { canonicalComparisonPath } from "../../../src/state/paths"
import { TransactionStore } from "../../../src/state/transaction-store"
import { registerWorkerResultTool } from "../../../src/tools/register-worker-result-tool"

// biome-ignore lint/style/noDefaultExport: OMP extension factories require a default export.
export default function todo9WorkerSurface(api: ExtensionAPI): void {
  const displayPath = process.cwd()
  const store = new TransactionStore({
    canonicalPath: canonicalComparisonPath(displayPath),
    displayPath,
  })
  registerWorkerResultTool(api, new WorkerResultAcceptance(new TaskEventLedger(store)))
}
