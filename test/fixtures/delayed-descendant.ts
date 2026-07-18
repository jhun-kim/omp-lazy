import { z } from "zod"

const [mode, sentinel] = z
  .tuple([
    z.enum(["parent", "fast-parent", "readiness-parent", "linger", "child", "readiness-child"]),
    z.string().min(1),
  ])
  .parse(Bun.argv.slice(2))

if (
  mode === "parent" ||
  mode === "fast-parent" ||
  mode === "readiness-parent" ||
  mode === "linger"
) {
  const child = Bun.spawn(
    [
      process.execPath,
      import.meta.path,
      mode === "readiness-parent" ? "readiness-child" : "child",
      sentinel,
    ],
    {
      detached: process.platform === "win32" && mode === "readiness-parent",
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  )
  if (mode === "readiness-parent") child.unref()
  if (mode === "parent") await Bun.sleep(250)
  if (mode === "readiness-parent") await Bun.sleep(250)
  if (mode === "linger") await Bun.sleep(2_000)
} else {
  await Bun.sleep(mode === "readiness-child" ? 1_000 : 500)
  await Bun.write(sentinel, "late descendant write\n")
}
