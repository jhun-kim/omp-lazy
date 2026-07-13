import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import { TaskEventLedger } from "../../../src/gates/task-event-ledger"
import { registerTaskSpawnGuard, TaskSpawnGuard } from "../../../src/gates/task-spawn-guard"
import {
  registerToolResultObserver,
  ToolResultObserver,
} from "../../../src/observers/tool-result-observer"
import { canonicalComparisonPath } from "../../../src/state/paths"
import { TransactionStore } from "../../../src/state/transaction-store"

// biome-ignore lint/style/noDefaultExport: OMP extension factories require a default export.
export default function todo8TaskSurface(api: ExtensionAPI): void {
  const displayPath = process.cwd()
  const ledger = new TaskEventLedger(
    new TransactionStore({ canonicalPath: canonicalComparisonPath(displayPath), displayPath }),
  )
  registerTaskSpawnGuard(api, new TaskSpawnGuard(ledger, 8))
  registerToolResultObserver(api, new ToolResultObserver(ledger))
}
