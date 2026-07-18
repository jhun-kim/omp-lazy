import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expectedProductRuntime } from "../../scripts/product-runtime-contract"
import { repositoryRoot } from "./package-test-helpers"

export async function completeDiscoveryCandidate(
  prefix: string,
  sandboxes: string[],
): Promise<string> {
  const candidate = await mkdtemp(join(repositoryRoot, `.todo3-discovery-${prefix}-`))
  sandboxes.push(candidate)
  await cp(join(repositoryRoot, "package.json"), join(candidate, "package.json"))
  await mkdir(join(candidate, "skills"), { recursive: true })
  await mkdir(join(candidate, "agents"), { recursive: true })
  await Promise.all([
    ...expectedProductRuntime.skillNames.map((name) => writeSkill(candidate, name)),
    ...expectedProductRuntime.agentNames.map((name) => writeAgent(candidate, name)),
  ])
  return candidate
}

export async function writeSkill(root: string, name: string): Promise<void> {
  const skillRoot = join(root, "skills", name)
  await mkdir(skillRoot, { recursive: true })
  await writeFile(join(skillRoot, "SKILL.md"), skillMarkdown(name, `${name} contract fixture`))
  if (name === "ulw-loop") {
    await mkdir(join(skillRoot, "references"), { recursive: true })
    await writeFile(join(skillRoot, "references", "full-workflow.md"), "# Full workflow\n")
  }
  if (name === "ulw-research") {
    await writeFile(join(skillRoot, "ATTRIBUTION.md"), "# Attribution\n")
  }
}

export async function writeAgent(root: string, name: string): Promise<void> {
  await writeFile(
    join(root, "agents", `${name}.md`),
    agentMarkdown(name, `${name} contract fixture`),
  )
}

export function skillMarkdown(name: string, description: string): string {
  const body =
    name === "ulw-loop" ? "Use the [full workflow](references/full-workflow.md)." : "Run."
  const attribution = name === "ulw-research" ? "\nSee [attribution](ATTRIBUTION.md)." : ""
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}${attribution}\n`
}

export function agentMarkdown(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\nblocking: false\n---\n\nReturn the declared fixture result.\n`
}
