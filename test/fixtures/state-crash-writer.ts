import { decodeStateEvent } from "../../src/state/codec"
import { canonicalComparisonPath } from "../../src/state/paths"
import { deadlineAfter } from "../../src/state/repo-lock"
import { type CrashPoint, TransactionStore } from "../../src/state/transaction-store"

const [rootPath, eventBytes, crashPoint] = process.argv.slice(2)
if (rootPath === undefined || eventBytes === undefined || crashPoint === undefined) {
  throw new Error("usage: state-crash-writer <root> <event-json> <crash-point>")
}
function parseCrashPoint(value: string): CrashPoint | null {
  switch (value) {
    case "before_event":
    case "after_event":
    case "after_run":
    case "after_index":
      return value
    default:
      return null
  }
}
const selected = parseCrashPoint(crashPoint)
if (selected === null) throw new Error("invalid crash point")
const event = decodeStateEvent(eventBytes)
if (!event.ok) throw event.error
if (event.value.schemaVersion !== 1) throw new Error("fixture event version mismatch")
const root = { canonicalPath: canonicalComparisonPath(rootPath), displayPath: rootPath }
await new TransactionStore(root).commit(event.value, {
  deadline: deadlineAfter(5_000),
  crash: (point) => {
    if (point === selected) process.exit(86)
  },
})
