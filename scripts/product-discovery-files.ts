import { access, readdir, readFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { parseFrontmatter } from "@oh-my-pi/pi-utils"
import { z } from "zod"
import { expectedProductRuntime } from "./product-runtime-contract"

const skillFrontmatterSchema = z.strictObject({
  description: z.string().min(1),
  name: z.string().min(1),
})

const agentFrontmatterSchema = z
  .strictObject({
    blocking: z.literal(false),
    description: z.string().min(1),
    name: z.string().min(1),
    output: z.unknown().optional(),
  })
  .passthrough()

const markdownReferencePattern = /\]\((?!https?:|mailto:|#)([^)]+)\)/g

type ParsedFrontmatter = Record<string, unknown> & { readonly name?: unknown }

export type ScannedDiscoveryNames = {
  readonly agentNames: readonly string[]
  readonly skillNames: readonly string[]
}

export class ProductDiscoveryContractError extends Error {
  override readonly name = "ProductDiscoveryContractError"
}

function contained(root: string, candidate: string | undefined): boolean {
  if (candidate === undefined || !isAbsolute(candidate)) return false
  const fromRoot = relative(root, candidate)
  return fromRoot.length === 0 || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
}

function pathName(path: string): string {
  return basename(path).replace(/\.md$/, "")
}

async function requireFile(path: string, label: string): Promise<void> {
  try {
    await access(path)
  } catch (error) {
    if (error instanceof Error) {
      throw new ProductDiscoveryContractError(`missing ${label}: ${path}`, { cause: error })
    }
    throw error
  }
}

function parseMarkdownFrontmatter(path: string, content: string): ParsedFrontmatter {
  return parseFrontmatter(content, { source: path }).frontmatter
}

async function verifyRelativeMarkdownReferences(
  root: string,
  path: string,
  content: string,
): Promise<void> {
  for (const match of content.matchAll(markdownReferencePattern)) {
    const rawTarget = match[1]
    if (rawTarget === undefined) continue
    const target = resolve(root, dirname(path), decodeURIComponent(rawTarget.split("#")[0] ?? ""))
    if (!contained(root, target)) {
      throw new ProductDiscoveryContractError(
        `escaping Markdown reference: ${path} -> ${rawTarget}`,
      )
    }
    await requireFile(target, `Markdown reference ${path} -> ${rawTarget}`)
  }
}

async function verifySkillFile(root: string, name: string): Promise<string> {
  const path = join(root, "skills", name, "SKILL.md")
  await requireFile(path, `skill file ${name}`)
  const content = await readFile(path, "utf8")
  const parsed = skillFrontmatterSchema.safeParse(parseMarkdownFrontmatter(path, content))
  if (!parsed.success)
    throw new ProductDiscoveryContractError(`malformed skill frontmatter: ${name}`)
  if (parsed.data.name !== name) {
    throw new ProductDiscoveryContractError(
      `skill identity mismatch: ${name} -> ${parsed.data.name}`,
    )
  }
  if (name === "ulw-research(omp)") {
    await requireFile(
      join(root, "skills", name, "ATTRIBUTION.md"),
      "skill attribution ulw-research(omp)",
    )
  }
  await verifyRelativeMarkdownReferences(root, path, content)
  return parsed.data.name
}

async function verifyAgentFile(root: string, name: string): Promise<string> {
  const path = join(root, "agents", `${name}.md`)
  await requireFile(path, `agent file ${name}`)
  const content = await readFile(path, "utf8")
  const parsed = agentFrontmatterSchema.safeParse(parseMarkdownFrontmatter(path, content))
  if (!parsed.success)
    throw new ProductDiscoveryContractError(`malformed agent frontmatter: ${name}`)
  if (parsed.data.name !== name) {
    throw new ProductDiscoveryContractError(
      `agent identity mismatch: ${name} -> ${parsed.data.name}`,
    )
  }
  await verifyRelativeMarkdownReferences(root, path, content)
  return parsed.data.name
}

export async function verifyExistingExpectedFiles(root: string): Promise<void> {
  await Promise.all([
    ...expectedProductRuntime.skillNames.map(async (name) => {
      if (await Bun.file(join(root, "skills", name, "SKILL.md")).exists())
        await verifySkillFile(root, name)
    }),
    ...expectedProductRuntime.agentNames.map(async (name) => {
      if (await Bun.file(join(root, "agents", `${name}.md`)).exists())
        await verifyAgentFile(root, name)
    }),
  ])
}

export async function verifyCompleteExpectedFiles(root: string): Promise<void> {
  await Promise.all([
    ...expectedProductRuntime.skillNames.map((name) => verifySkillFile(root, name)),
    ...expectedProductRuntime.agentNames.map((name) => verifyAgentFile(root, name)),
  ])
}

async function scannedSkillNames(root: string): Promise<readonly string[]> {
  const skillsRoot = join(root, "skills")
  const entries = await readdir(skillsRoot, { withFileTypes: true }).catch(() => [])
  return Promise.all(
    entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map(async (entry) => {
        const path = join(skillsRoot, entry.name, "SKILL.md")
        const content = await readFile(path, "utf8").catch(() => "")
        if (content.length === 0) return entry.name
        const frontmatter = parseMarkdownFrontmatter(path, content)
        return typeof frontmatter.name === "string" && frontmatter.name.trim().length > 0
          ? frontmatter.name.trim()
          : entry.name
      }),
  )
}

async function scannedAgentNames(root: string): Promise<readonly string[]> {
  const agentsRoot = join(root, "agents")
  const entries = await readdir(agentsRoot, { withFileTypes: true }).catch(() => [])
  return Promise.all(
    entries
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
      .map(async (entry) => {
        const path = join(agentsRoot, entry.name)
        const content = await readFile(path, "utf8")
        const frontmatter = parseMarkdownFrontmatter(path, content)
        return typeof frontmatter.name === "string" && frontmatter.name.trim().length > 0
          ? frontmatter.name.trim()
          : pathName(entry.name)
      }),
  )
}

export async function scannedProductNames(root: string): Promise<ScannedDiscoveryNames> {
  const [skillNames, agentNames] = await Promise.all([
    scannedSkillNames(root),
    scannedAgentNames(root),
  ])
  return { agentNames, skillNames }
}
