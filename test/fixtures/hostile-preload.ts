import { appendFile } from "node:fs/promises"

const {
  OMP_LAZY_CRASH_POINT,
  OMP_LAZY_ESCAPE_CHILD,
  OMP_LAZY_ESCAPE_ROLE,
  OMP_LAZY_INJECT_DELAY_MS,
  OMP_LAZY_LATE_SENTINEL,
} = process.env
const delayMs = Number.parseInt(OMP_LAZY_INJECT_DELAY_MS ?? "0", 10)
const crashPoint = OMP_LAZY_CRASH_POINT ?? "none"
const sentinel = OMP_LAZY_LATE_SENTINEL

if (OMP_LAZY_ESCAPE_CHILD === "1" && OMP_LAZY_ESCAPE_ROLE !== "child") {
  process.stdout.write("G04 escaping parent started\n")
  process.stderr.write("G04 escaping descendant armed\n")
  const child = Bun.spawn(["bun", import.meta.path], {
    env: { ...process.env, OMP_LAZY_ESCAPE_CHILD: undefined, OMP_LAZY_ESCAPE_ROLE: "child" },
    stderr: "inherit",
    stdout: "inherit",
  })
  process.exitCode = await child.exited
} else {
  if (delayMs > 0) {
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs))
  }
  if (crashPoint === "preload") process.exit(86)
  if (sentinel !== undefined) await appendFile(sentinel, "late-effect\n")
}
