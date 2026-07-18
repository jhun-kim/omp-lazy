import { realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { loadCapability, type Skill } from "@oh-my-pi/pi-coding-agent/discovery"
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery"
import { z } from "zod"
import { assertExactProductDiscovery } from "./product-discovery-contract"

const argumentsSchema = z.union([z.tuple([]), z.tuple([z.literal("--cwd"), z.string().min(1)])])

async function main(): Promise<void> {
  const parsed = argumentsSchema.parse(Bun.argv.slice(2))
  const cwd = await realpath(resolve(parsed.length === 0 ? process.cwd() : parsed[1]))
  if (parsed.length === 0 || (await Bun.file(join(cwd, "package.json")).exists())) {
    const receipt = await assertExactProductDiscovery(cwd)
    process.stdout.write(
      `${JSON.stringify({
        agentPaths: receipt.agentPaths,
        mode: "product",
        productAgentNames: receipt.productAgentNames,
        productSkillNames: receipt.productSkillNames,
        skillPaths: receipt.skillPaths,
        warnings: receipt.warnings,
      })}\n`,
    )
    return
  }
  const [skills, agents] = await Promise.all([
    loadCapability<Skill>("skills", { cwd, providers: ["omp-plugins"] }),
    discoverAgents(cwd),
  ])
  process.stdout.write(
    `${JSON.stringify({
      agentNames: agents.agents.map((agent) => agent.name).sort(),
      agentPaths: agents.agents.map((agent) => agent.filePath).filter((path) => path !== undefined),
      warnings: skills.warnings,
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
