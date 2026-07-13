import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { loadCapability, type Skill } from "@oh-my-pi/pi-coding-agent/discovery"
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery"
import { z } from "zod"

const argumentsSchema = z.tuple([z.literal("--cwd"), z.string().min(1)])

async function main(): Promise<void> {
  const parsed = argumentsSchema.parse(Bun.argv.slice(2))
  const cwd = await realpath(resolve(parsed[1]))
  const [skills, agents] = await Promise.all([
    loadCapability<Skill>("skills", { cwd, providers: ["omp-plugins"] }),
    discoverAgents(cwd),
  ])
  process.stdout.write(
    `${JSON.stringify({
      agentNames: agents.agents.map((agent) => agent.name).sort(),
      agentPaths: agents.agents.map((agent) => agent.filePath).filter((path) => path !== undefined),
      errors: skills.warnings,
      skillNames: skills.items.map((skill) => skill.name).sort(),
      skillPaths: skills.items.map((skill) => skill.path).sort(),
    })}\n`,
  )
  if (skills.warnings.length > 0) process.exitCode = 1
}

// no-excuse-ok: catch — discovery probe is a CLI boundary.
try {
  await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
