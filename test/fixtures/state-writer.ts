import { writeFile } from "node:fs/promises"
import { decodeStateEvent } from "../../src/state/codec"
import { canonicalComparisonPath } from "../../src/state/paths"
import { deadlineAfter } from "../../src/state/repo-lock"
import { TransactionStore } from "../../src/state/transaction-store"

const [rootPath, eventBytes, outputPath] = process.argv.slice(2)
if (rootPath === undefined || eventBytes === undefined || outputPath === undefined) {
  throw new Error("usage: state-writer <root> <event-json> <output>")
}
const event = decodeStateEvent(eventBytes)
if (!event.ok) throw event.error
const root = { canonicalPath: canonicalComparisonPath(rootPath), displayPath: rootPath }
const result = await new TransactionStore(root).commit(event.value, {
  deadline: deadlineAfter(5_000),
})
await writeFile(outputPath, JSON.stringify(result))
