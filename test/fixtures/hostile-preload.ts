import { appendFile } from "node:fs/promises"

const { OMP_LAZY_CRASH_POINT, OMP_LAZY_INJECT_DELAY_MS, OMP_LAZY_LATE_SENTINEL } = process.env
const delayMs = Number.parseInt(OMP_LAZY_INJECT_DELAY_MS ?? "0", 10)
const crashPoint = OMP_LAZY_CRASH_POINT ?? "none"
const sentinel = OMP_LAZY_LATE_SENTINEL

if (delayMs > 0) await Bun.sleep(delayMs)
if (crashPoint === "preload") process.exit(86)
if (sentinel !== undefined) await appendFile(sentinel, "late-effect\n")
