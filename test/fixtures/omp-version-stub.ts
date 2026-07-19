import { appendFile } from "node:fs/promises"
import { z } from "zod"

const argumentsSchema = z.tuple([z.string().min(1)]).rest(z.string())

const [argvLog, ...command] = argumentsSchema.parse(Bun.argv.slice(2))

if (command.length === 1 && command[0] === "--version") {
  process.stdout.write("omp/16.4.8\n")
} else {
  await appendFile(argvLog, `${JSON.stringify(command)}\n`)
  process.stderr.write("outdated OMP fixture rejects post-version commands\n")
  process.exitCode = 17
}
