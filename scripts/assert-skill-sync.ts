import { access, readdir, readFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { parseFrontmatter } from "@oh-my-pi/pi-utils"
import type { WorkflowActivationId } from "../src/activation/types"
import { COMMAND_DEFINITIONS } from "../src/commands/command-definitions"
import { expectedProductRuntime } from "./product-runtime-contract"

const workflowSkillNames = {
  contribute_bug_fix: "lcx-contribute-bug-fix(omp)",
  doctor: "lcx-doctor(omp)",
  report_bug: "lcx-report-bug(omp)",
  start_work: "start-work(omp)",
  teammode: "teammode(omp)",
  ultrawork: "ultrawork(omp)",
  ulw_deliver: "ulw-deliver(omp)",
  ulw_loop: "ulw-loop(omp)",
  ulw_plan: "ulw-plan(omp)",
  ulw_research: "ulw-research(omp)",
} as const satisfies Record<WorkflowActivationId, string>

const requiredSkillFiles = {
  "lcx-contribute-bug-fix(omp)": [],
  "lcx-doctor(omp)": [],
  "lcx-report-bug(omp)": [],
  "ulw-deliver(omp)": [],
  "ulw-loop(omp)": ["references/full-workflow.md"],
  "ulw-research(omp)": ["ATTRIBUTION.md"],
  "start-work(omp)": [],
  "teammode(omp)": [],
  "ultrawork(omp)": [],
  "ulw-plan(omp)": [],
} as const satisfies Record<(typeof expectedProductRuntime.skillNames)[number], readonly string[]>

const requiredContentTokens = {
  "lcx-contribute-bug-fix(omp)": [],
  "lcx-doctor(omp)": [],
  "lcx-report-bug(omp)": [],
  "start-work(omp)": [".omo/plans", "omp_lazy_accept_worker_result"],
  "teammode(omp)": [],
  "ultrawork(omp)": ["ULTRAWORK MODE ENABLED!", "<!-- omp-lazy-ultrawork-contract:v1 -->"],
  "ulw-deliver(omp)": [
    "omp_lazy_accept_worker_result",
    "<!-- omp-lazy-ulw-deliver-contract:v1 -->",
  ],
  "ulw-loop(omp)": ["references/full-workflow.md"],
  "ulw-plan(omp)": [],
  "ulw-research(omp)": ["ATTRIBUTION.md", "EXPAND"],
} as const satisfies Record<(typeof expectedProductRuntime.skillNames)[number], readonly string[]>

const markdownReferencePattern = /\]\((?!https?:|mailto:|#)([^)]+)\)/g

type ExpectedSkillName = (typeof expectedProductRuntime.skillNames)[number]

type SkillFrontmatter = {
  readonly description: string
  readonly name: string
}

export type SkillSyncReceipt = {
  readonly commandToSkill: Readonly<Record<WorkflowActivationId, string>>
  readonly requiredFiles: readonly string[]
  readonly skillNames: readonly string[]
  readonly status: "PASS"
}

export class SkillSyncError extends Error {
  override readonly name = "SkillSyncError"
  constructor(readonly failures: readonly string[]) {
    super(failures.join("\n"))
  }
}

function contained(root: string, candidate: string | undefined): boolean {
  if (candidate === undefined || !isAbsolute(candidate)) return false
  const fromRoot = relative(root, candidate)
  return fromRoot.length === 0 || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
}

function parseSkillFrontmatter(path: string, source: string): SkillFrontmatter | null {
  const frontmatter = parseFrontmatter(source, { source: path }).frontmatter
  const { description, name } = frontmatter
  return typeof name === "string" && typeof description === "string" ? { description, name } : null
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

async function listSkillDirectories(root: string): Promise<readonly string[]> {
  const entries = await readdir(join(root, "skills"), { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort()
}

async function verifyMarkdownReferences(
  root: string,
  path: string,
  source: string,
): Promise<readonly string[]> {
  const failures: string[] = []
  for (const match of source.matchAll(markdownReferencePattern)) {
    const rawTarget = match[1]
    if (rawTarget === undefined) continue
    const target = resolve(root, dirname(path), decodeURIComponent(rawTarget.split("#")[0] ?? ""))
    if (!contained(root, target)) {
      failures.push(`escaping Markdown reference: ${relative(root, path)} -> ${rawTarget}`)
    } else if (!(await fileExists(target))) {
      failures.push(`missing Markdown reference: ${relative(root, path)} -> ${rawTarget}`)
    }
  }
  return failures
}

function findDuplicateNames(names: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const duplicates: string[] = []
  for (const name of names) {
    if (seen.has(name) && !duplicates.includes(name)) duplicates.push(name)
    seen.add(name)
  }
  return duplicates
}

async function verifySkill(root: string, name: ExpectedSkillName): Promise<readonly string[]> {
  const path = join(root, "skills", name, "SKILL.md")
  if (!(await fileExists(path))) return [`missing skill file: ${name}`]
  const source = await readFile(path, "utf8")
  const parsed = parseSkillFrontmatter(path, source)
  const failures: string[] = []
  if (parsed === null) {
    failures.push(`malformed skill frontmatter: ${name}`)
  } else if (parsed.name !== name) {
    failures.push(`skill identity mismatch: ${name} -> ${parsed.name}`)
  }
  for (const token of requiredContentTokens[name] ?? []) {
    if (!source.includes(token)) failures.push(`missing skill contract token: ${name} -> ${token}`)
  }
  for (const required of requiredSkillFiles[name] ?? []) {
    const requiredPath = join(root, "skills", name, required)
    if (!(await fileExists(requiredPath)))
      failures.push(`missing required skill file: ${name}/${required}`)
  }
  failures.push(...(await verifyMarkdownReferences(root, path, source)))
  return failures
}

export async function assertSkillSync(root: string): Promise<SkillSyncReceipt> {
  const skillNames = await listSkillDirectories(root)
  const failures: string[] = []
  const expectedSkills: readonly ExpectedSkillName[] = expectedProductRuntime.skillNames
  const expectedSet = new Set<string>(expectedSkills)
  const discoveredSet = new Set<string>(skillNames)
  const duplicates = findDuplicateNames(skillNames)
  if (duplicates.length > 0) failures.push(`duplicate skill directories: ${duplicates.join(", ")}`)
  for (const name of expectedSkills) {
    if (!discoveredSet.has(name)) failures.push(`missing expected skill directory: ${name}`)
  }
  for (const name of skillNames) {
    if (!expectedSet.has(name)) failures.push(`unexpected skill directory: ${name}`)
  }
  const commandWorkflows = COMMAND_DEFINITIONS.map((definition) => definition.workflow).sort()
  const mappedWorkflows = Object.keys(workflowSkillNames).sort()
  if (JSON.stringify(commandWorkflows) !== JSON.stringify(mappedWorkflows)) {
    failures.push("command-to-skill workflow inventory mismatch")
  }
  for (const definition of COMMAND_DEFINITIONS) {
    const skillName = workflowSkillNames[definition.workflow]
    if (!expectedSet.has(skillName)) {
      failures.push(`command-to-skill mapping targets unknown skill: ${definition.workflow}`)
    }
  }
  const perSkillFailures = await Promise.all(expectedSkills.map((name) => verifySkill(root, name)))
  failures.push(...perSkillFailures.flat())
  if (failures.length > 0) throw new SkillSyncError(failures)
  return {
    commandToSkill: workflowSkillNames,
    requiredFiles: Object.entries(requiredSkillFiles).flatMap(([name, files]) =>
      files.map((file) => `skills/${name}/${file}`),
    ),
    skillNames,
    status: "PASS",
  }
}

function parseRootArgument(args: readonly string[]): string {
  if (args.length === 0) return join(import.meta.dir, "..")
  return args.length === 2 && args[0] === "--root" ? resolve(args[1] ?? "") : ""
}

if (import.meta.main) {
  const cliRoot = parseRootArgument(Bun.argv.slice(2))
  if (cliRoot.length === 0) {
    process.stderr.write("usage: bun scripts/assert-skill-sync.ts [--root <path>]\n")
    process.exitCode = 2
  } else {
    // no-excuse-ok: catch - sync assertion is a CLI boundary.
    try {
      const receipt = await assertSkillSync(cliRoot)
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
    } catch (error) {
      if (error instanceof SkillSyncError) {
        process.stderr.write(`${error.message}\n`)
        process.exitCode = 1
      } else {
        throw error
      }
    }
  }
}
