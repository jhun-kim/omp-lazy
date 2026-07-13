import { join } from "node:path"
import { loadCapability, type Skill } from "@oh-my-pi/pi-coding-agent/discovery"
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader"
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery"

export async function probeStagedRuntime(
  installedRoot: string,
  project: string,
): Promise<{
  readonly agentNames: readonly string[]
  readonly loaderErrors: readonly { readonly error: string; readonly path: string }[]
  readonly skillNames: readonly string[]
}> {
  const [loader, skills, agents] = await Promise.all([
    loadExtensions([join(installedRoot, "src", "index.ts")], project),
    loadCapability<Skill>("skills", { cwd: project, providers: ["omp-plugins"] }),
    discoverAgents(project),
  ])
  return {
    agentNames: agents.agents.map((agent) => agent.name).sort(),
    loaderErrors: loader.errors,
    skillNames: skills.items.map((skill) => skill.name).sort(),
  }
}
