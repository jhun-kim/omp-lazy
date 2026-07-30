import { lstat, readFile, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { z } from "zod"
import { expectedProductRuntime } from "./product-runtime-contract"

const packageSchema = z.object({
  scripts: z.record(z.string().min(1), z.string().min(1)).readonly(),
})

export type RuntimeBehaviorRow = {
  readonly id: string
  readonly en: string
  readonly ko: string
  readonly description: string
}

/**
 * Single source-of-truth constant for the runtime behavior table.
 * Both README.md and README.ko.md must contain exactly these rows.
 */
export const RUNTIME_BEHAVIOR_ROWS: readonly RuntimeBehaviorRow[] = [
  {
    id: "directive_activation",
    en: "Automatic directive activation",
    ko: "자동 directive activation",
    description:
      "An allowlisted trigger token in a user prompt activates the matching workflow directive as a hidden injected message, with the user's own text byte-identical.",
  },
  {
    id: "idle_continuation",
    en: "Idle auto-continuation",
    ko: "유휴 시 자동 continuation",
    description:
      "An active start-work plan or ulw-loop goal continues itself on agent idle under a bounded, persisted counter, with a steering reminder instead of a rewritten prompt.",
  },
  {
    id: "delegation_model_chains",
    en: "Category-equivalent delegation",
    ko: "카테고리 동등 delegation",
    description:
      "Each agent declares an ordered model chain plus thinkingLevel; chain fallback is attempted in order with per-attempt provenance, and blocked spawns return a corrective reason.",
  },
  {
    id: "status_line",
    en: "Live observability",
    ko: "실시간 observability",
    description:
      "The OMP status line and working message show the active workflow, run, progress and model role, degrading silently when there is no UI.",
  },
  {
    id: "rules_injection",
    en: "Contextual knowledge injection",
    ko: "컨텍스트 기반 knowledge injection",
    description:
      "Repository-scoped .omo/rules/*.md glob-matched rules and a truncation-safe directive/skill catalog are assembled under an explicit byte budget with deterministic priority.",
  },
] as const

export type RuntimeBehaviorVerifyResult =
  | { readonly status: "PASS"; readonly ids: readonly string[] }
  | {
      readonly status: "FAIL"
      readonly missing: readonly string[]
      readonly extra: readonly string[]
    }

/**
 * Verifies that a markdown string contains exactly the runtime behavior rows
 * from the source-of-truth constant. Works on in-memory strings (no file I/O).
 */
export function verifyRuntimeBehaviorRows(markdown: string): RuntimeBehaviorVerifyResult {
  const expectedIds = RUNTIME_BEHAVIOR_ROWS.map((row) => row.id).toSorted()
  const lines = markdown.split(/\r?\n/)
  const sectionStart = lines.findIndex((line) => line.trim() === "## Runtime behavior")
  if (sectionStart < 0) {
    return { status: "FAIL", missing: expectedIds, extra: [] }
  }

  const foundIds: string[] = []
  for (const line of lines.slice(sectionStart + 1)) {
    const trimmed = line.trim()
    if (trimmed.startsWith("## ") && trimmed !== "## Runtime behavior") break
    if (!trimmed.startsWith("|")) continue
    const match = /^\|\s*`([^`]+)`\s*\|/.exec(trimmed)
    if (match?.[1] !== undefined) {
      foundIds.push(match[1])
    }
  }

  const foundSet = new Set(foundIds)
  const expectedSet = new Set(expectedIds)
  const missing = expectedIds.filter((id) => !foundSet.has(id))
  const extra = foundIds.filter((id) => !expectedSet.has(id))

  if (missing.length === 0 && extra.length === 0) {
    return { status: "PASS", ids: foundIds.toSorted() }
  }
  return { status: "FAIL", missing, extra }
}

export type ReadmeContractReceipt = {
  readonly agentNames: readonly string[]
  readonly commandNames: readonly string[]
  readonly packageScripts: readonly string[]
  readonly runtimeBehaviorIds: readonly string[]
  readonly shellCommands: readonly (readonly string[])[]
  readonly skillNames: readonly string[]
  readonly status: "PASS"
}

export class ReadmeContractError extends Error {
  override readonly name = "ReadmeContractError"
}

function tokenizeShellLine(line: string): readonly string[] {
  const tokens: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  let escaped = false
  for (const character of line.trim()) {
    if (escaped) {
      current += character
      escaped = false
    } else if (character === "\\" && quote !== "'") {
      escaped = true
    } else if (quote !== undefined) {
      if (character === quote) quote = undefined
      else current += character
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ""
      }
    } else if (new Set(["&", "|", ";", ">", "<"]).has(character)) {
      throw new ReadmeContractError(
        `shell operators are not allowed in documented commands: ${line}`,
      )
    } else {
      current += character
    }
  }
  if (escaped || quote !== undefined) {
    throw new ReadmeContractError(`unterminated shell quoting: ${line}`)
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

export function parseShellCommandBlocks(markdown: string): readonly (readonly string[])[] {
  const commands: (readonly string[])[] = []
  const pattern = /```(?:sh|bash|shell)\r?\n([\s\S]*?)```/g
  for (const block of markdown.matchAll(pattern)) {
    const body = block[1] ?? ""
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (line.length === 0 || line.startsWith("#")) continue
      const command = tokenizeShellLine(line)
      if (command.length > 0) commands.push(command)
    }
  }
  return commands
}

function tableRows(markdown: string, heading: string): readonly (readonly string[])[] {
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`)
  if (start < 0) throw new ReadmeContractError(`missing README table section: ${heading}`)
  const rows: string[][] = []
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("|")) {
      if (rows.length > 0) break
      continue
    }
    rows.push(
      trimmed
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    )
  }
  if (rows.length < 3) throw new ReadmeContractError(`README table has no data: ${heading}`)
  return rows.slice(2)
}

function codeValue(cell: string): string {
  const match = /^`([^`]+)`$/.exec(cell)
  if (match?.[1] === undefined)
    throw new ReadmeContractError(`table contract value must use code: ${cell}`)
  return match[1]
}

function exactNames(markdown: string, heading: string): readonly string[] {
  const names = tableRows(markdown, heading).map((row) =>
    codeValue(row[0] ?? "").replace(/^\//, ""),
  )
  if (new Set(names).size !== names.length) {
    throw new ReadmeContractError(`duplicate README ${heading.toLowerCase()} entry`)
  }
  return names.toSorted()
}

function assertExact(label: string, actual: readonly string[], expected: readonly string[]): void {
  if (JSON.stringify(actual) !== JSON.stringify([...expected].toSorted())) {
    throw new ReadmeContractError(
      `${label} table mismatch: expected ${JSON.stringify([...expected].toSorted())}, received ${JSON.stringify(actual)}`,
    )
  }
}

function contained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
}

async function assertScriptReference(root: string, path: string): Promise<void> {
  const candidate = resolve(root, path)
  if (!contained(root, candidate))
    throw new ReadmeContractError(`escaping shell script reference: ${path}`)
  try {
    const [canonicalRoot, canonical, metadata] = await Promise.all([
      realpath(root),
      realpath(candidate),
      lstat(candidate),
    ])
    if (!contained(canonicalRoot, canonical) || !metadata.isFile() || metadata.isSymbolicLink()) {
      throw new ReadmeContractError(`invalid shell script reference: ${path}`)
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new ReadmeContractError(`missing shell script reference: ${path}`)
    }
    throw error
  }
}

async function verifyCommandReference(
  root: string,
  scripts: Readonly<Record<string, string>>,
  command: readonly string[],
): Promise<void> {
  if (command[0] !== "bun") return
  if (command[1] === "run") {
    const alias = command[2]
    if (alias === undefined || !(alias in scripts)) {
      throw new ReadmeContractError(`unknown documented package script: ${alias ?? "<missing>"}`)
    }
    return
  }
  const script = command[1]
  if (script?.startsWith("scripts/") === true) await assertScriptReference(root, script)
}

export async function verifyReadmeContract(rootValue: string): Promise<ReadmeContractReceipt> {
  const root = await realpath(rootValue)
  const [markdown, koMarkdown, packageSource] = await Promise.all([
    readFile(join(root, "README.md"), "utf8"),
    readFile(join(root, "README.ko.md"), "utf8"),
    readFile(join(root, "package.json"), "utf8"),
  ])
  const manifest = packageSchema.parse(JSON.parse(packageSource))
  const packageRows = tableRows(markdown, "Package scripts")
  const documentedScripts = packageRows.map(
    (row) => [codeValue(row[0] ?? ""), codeValue(row[1] ?? "")] as const,
  )
  const expectedScripts = Object.entries(manifest.scripts).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )
  if (
    JSON.stringify(documentedScripts.toSorted(([left], [right]) => left.localeCompare(right))) !==
    JSON.stringify(expectedScripts)
  ) {
    throw new ReadmeContractError("package script table mismatch")
  }

  const shellCommands = parseShellCommandBlocks(markdown)
  for (const command of shellCommands) await verifyCommandReference(root, manifest.scripts, command)
  for (const expansion of Object.values(manifest.scripts)) {
    const command = tokenizeShellLine(expansion)
    await verifyCommandReference(root, manifest.scripts, command)
  }

  const commandNames = exactNames(markdown, "Product commands")
  const skillNames = exactNames(markdown, "Skills")
  const agentNames = exactNames(markdown, "Agents")
  assertExact("product command", commandNames, expectedProductRuntime.commandNames)
  assertExact("skill", skillNames, expectedProductRuntime.skillNames)
  assertExact("agent", agentNames, expectedProductRuntime.agentNames)

  // Verify runtime behavior rows in both READMEs
  const enResult = verifyRuntimeBehaviorRows(markdown)
  if (enResult.status === "FAIL") {
    const parts: string[] = []
    if (enResult.missing.length > 0) parts.push(`missing: ${enResult.missing.join(", ")}`)
    if (enResult.extra.length > 0) parts.push(`extra: ${enResult.extra.join(", ")}`)
    throw new ReadmeContractError(`README.md runtime behavior table mismatch: ${parts.join("; ")}`)
  }

  const koResult = verifyRuntimeBehaviorRows(koMarkdown)
  if (koResult.status === "FAIL") {
    const parts: string[] = []
    if (koResult.missing.length > 0) parts.push(`missing: ${koResult.missing.join(", ")}`)
    if (koResult.extra.length > 0) parts.push(`extra: ${koResult.extra.join(", ")}`)
    throw new ReadmeContractError(
      `README.ko.md runtime behavior table mismatch: ${parts.join("; ")}`,
    )
  }

  return {
    agentNames,
    commandNames,
    packageScripts: expectedScripts.map(([name]) => name),
    runtimeBehaviorIds: enResult.ids,
    shellCommands,
    skillNames,
    status: "PASS",
  }
}
