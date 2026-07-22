import { writeSync } from "node:fs"

const payload = "x".repeat(128 * 1_048_576)

writeSync(1, payload)
writeSync(2, payload)
