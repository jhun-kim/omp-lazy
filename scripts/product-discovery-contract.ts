import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { loadCapability, type Skill } from "@oh-my-pi/pi-coding-agent/discovery"
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery"
import {
  ProductDiscoveryContractError,
  scannedProductNames,
  verifyCompleteExpectedFiles,
  verifyExistingExpectedFiles,
} from "./product-discovery-files"
import { expectedProductRuntime } from "./product-runtime-contract"

export { ProductDiscoveryContractError } from "./product-discovery-files"

export type ProductDiscoveryReceipt = {
  readonly agentNames: readonly string[]
  readonly agentPaths: readonly string[]
  readonly missingAgentNames: readonly string[]
  readonly missingSkillNames: readonly string[]
  readonly productAgentNames: readonly string[]
  readonly productSkillNames: readonly string[]
  readonly skillNames: readonly string[]
  readonly skillPaths: readonly string[]
  readonly unexpectedAgentNames: readonly string[]
  readonly unexpectedSkillNames: readonly string[]
  readonly unownedAgentNames: readonly string[]
  readonly unownedSkillNames: readonly string[]
  readonly warnings: readonly string[]
}

function contained(root: string, candidate: string | undefined): boolean {
  if (candidate === undefined || !isAbsolute(candidate)) return false
  const fromRoot = relative(root, candidate)
  return fromRoot.length === 0 || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
}

function difference(expected: readonly string[], actual: readonly string[]): readonly string[] {
  const actualSet = new Set(actual)
  return expected.filter((name) => !actualSet.has(name))
}

function unexpected(actual: readonly string[], expected: readonly string[]): readonly string[] {
  const expectedSet = new Set(expected)
  return actual.filter((name) => !expectedSet.has(name))
}

function containsName(names: readonly string[], name: string): boolean {
  return new Set<string>(names).has(name)
}

function duplicateNames(label: string, names: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const duplicates: string[] = []
  for (const name of names) {
    if (seen.has(name) && !duplicates.includes(name)) duplicates.push(name)
    seen.add(name)
  }
  return duplicates.map((name) => `${label}:${name}`)
}

async function configuredProject(root: string): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "omp-lazy-discovery-project-"))
  await mkdir(join(project, ".omp"), { recursive: true })
  await writeFile(
    join(project, ".omp", "settings.json"),
    `${JSON.stringify({ extensions: [root] })}\n`,
  )
  return project
}

export async function inspectProductDiscovery(
  root: string,
  configuredProjectPath?: string,
): Promise<ProductDiscoveryReceipt> {
  const project = configuredProjectPath ?? (await configuredProject(root))
  try {
    const [skills, agents] = await Promise.all([
      loadCapability<Skill>("skills", { cwd: project, providers: ["omp-plugins"] }),
      discoverAgents(project),
    ])
    const skillPaths = skills.items.map((skill) => skill.path).sort()
    const agentPaths = agents.agents
      .map((agent) => agent.filePath)
      .filter((path): path is string => path !== undefined)
      .sort()
    const productSkillNames = skills.items
      .filter((skill) => contained(root, skill.path))
      .map((skill) => skill.name)
      .sort()
    const productAgentNames = agents.agents
      .filter((agent) => contained(root, agent.filePath))
      .map((agent) => agent.name)
      .sort()
    return {
      agentNames: agents.agents.map((agent) => agent.name).sort(),
      agentPaths,
      missingAgentNames: difference(expectedProductRuntime.agentNames, productAgentNames),
      missingSkillNames: difference(expectedProductRuntime.skillNames, productSkillNames),
      productAgentNames,
      productSkillNames,
      skillNames: skills.items.map((skill) => skill.name).sort(),
      skillPaths,
      unexpectedAgentNames: unexpected(productAgentNames, expectedProductRuntime.agentNames),
      unexpectedSkillNames: unexpected(productSkillNames, expectedProductRuntime.skillNames),
      unownedAgentNames: agents.agents
        .filter(
          (agent) =>
            containsName(expectedProductRuntime.agentNames, agent.name) &&
            !contained(root, agent.filePath),
        )
        .map((agent) => agent.name)
        .sort(),
      unownedSkillNames: skills.items
        .filter(
          (skill) =>
            containsName(expectedProductRuntime.skillNames, skill.name) &&
            !contained(root, skill.path),
        )
        .map((skill) => skill.name)
        .sort(),
      warnings: skills.warnings,
    }
  } finally {
    if (configuredProjectPath === undefined) await rm(project, { force: true, recursive: true })
  }
}

function discoveryFailures(receipt: ProductDiscoveryReceipt): readonly string[] {
  return [
    receipt.warnings.length > 0 ? `discovery warnings: ${receipt.warnings.join(", ")}` : undefined,
    receipt.unownedSkillNames.length > 0
      ? `unowned skill discovery: ${receipt.unownedSkillNames.join(", ")}`
      : undefined,
    receipt.unownedAgentNames.length > 0
      ? `unowned agent discovery: ${receipt.unownedAgentNames.join(", ")}`
      : undefined,
    receipt.missingSkillNames.length > 0
      ? `missing skill discovery: ${receipt.missingSkillNames.join(", ")}`
      : undefined,
    receipt.missingAgentNames.length > 0
      ? `missing agent discovery: ${receipt.missingAgentNames.join(", ")}`
      : undefined,
    receipt.unexpectedSkillNames.length > 0
      ? `unexpected skill discovery: ${receipt.unexpectedSkillNames.join(", ")}`
      : undefined,
    receipt.unexpectedAgentNames.length > 0
      ? `unexpected agent discovery: ${receipt.unexpectedAgentNames.join(", ")}`
      : undefined,
  ].filter((failure): failure is string => failure !== undefined)
}

export async function assertExactProductDiscovery(
  root: string,
  configuredProjectPath?: string,
): Promise<ProductDiscoveryReceipt> {
  const [, scannedNames] = await Promise.all([
    verifyExistingExpectedFiles(root),
    scannedProductNames(root),
  ])
  const duplicateMessages = [
    ...duplicateNames("skill", scannedNames.skillNames),
    ...duplicateNames("agent", scannedNames.agentNames),
  ]
  if (duplicateMessages.length > 0) {
    throw new ProductDiscoveryContractError(
      `duplicate discovery names: ${duplicateMessages.join(", ")}`,
    )
  }
  const receipt = await inspectProductDiscovery(root, configuredProjectPath)
  const failures = discoveryFailures(receipt)
  if (failures.length > 0) throw new ProductDiscoveryContractError(failures.join("; "))
  await verifyCompleteExpectedFiles(root)
  return receipt
}
