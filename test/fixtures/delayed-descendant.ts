import { z } from "zod"

const [mode, sentinel] = z
  .tuple([z.enum(["parent", "fast-parent", "linger", "child"]), z.string().min(1)])
  .parse(Bun.argv.slice(2))

if (mode === "parent" || mode === "fast-parent" || mode === "linger") {
  Bun.spawn(["bun", import.meta.path, "child", sentinel], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  if (mode === "parent") await Bun.sleep(250)
  if (mode === "linger") await Bun.sleep(2_000)
} else {
  await Bun.sleep(500)
  await Bun.write(sentinel, "late descendant write\n")
}
