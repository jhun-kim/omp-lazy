import { lstat, open, readdir, realpath } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { z } from "zod"
import { canonicalComparisonPath, isCanonicalPathContained } from "../state/paths"

const MAX_RULE_BYTES = 64 * 1_024
const RULE_EXTENSION = ".md"

export type RuleDiscoveryCode =
  | "rules_root_unreadable"
  | "rules_root_escaped"
  | "rule_path_escaped"
  | "rule_link_rejected"
  | "rule_not_regular_file"
  | "rule_unreadable"
  | "rule_too_large"
  | "malformed_rule_frontmatter"

export class RuleDiscoveryError extends Error {
  override readonly name = "RuleDiscoveryError"
  constructor(
    readonly code: RuleDiscoveryCode,
    readonly reason: string,
  ) {
    super(`${code}: ${reason}`)
  }
}

export type DiscoveredRule = {
  readonly fileName: string
  readonly relativePath: string
  readonly displayPath: string
  readonly globs: readonly string[]
  readonly order: number | null
  readonly description: string | null
  readonly body: string
  readonly bytes: number
}

export type RuleRejection = {
  readonly fileName: string
  readonly error: RuleDiscoveryError
}

export type RulesDiscoveryResult =
  | {
      readonly ok: true
      readonly rulesRoot: string
      readonly rules: readonly DiscoveredRule[]
      readonly rejections: readonly RuleRejection[]
    }
  | { readonly ok: false; readonly error: RuleDiscoveryError }

export type RuleResult =
  | { readonly ok: true; readonly value: DiscoveredRule }
  | { readonly ok: false; readonly error: RuleDiscoveryError }

/** Renders any accepted separator form as the POSIX form used in all reported paths. */
export function normalizeRuleSeparators(path: string): string {
  return path.replaceAll("\\", "/")
}

function platformPath(path: string): string {
  return resolve(process.platform === "win32" ? path.replaceAll("/", "\\") : path)
}

export function rulesRootPath(repositoryRoot: string): string {
  return join(platformPath(repositoryRoot), ".omo", "rules")
}

const RuleFrontmatterSchema = z
  .object({
    globs: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(200)
          .transform(normalizeRuleSeparators)
          .refine(
            (glob) =>
              !isAbsolute(glob) &&
              !glob.startsWith("/") &&
              !/^[A-Za-z]:/.test(glob) &&
              !glob.split("/").includes("..") &&
              !glob.includes("\u0000"),
            { error: "glob must be a repository-relative pattern" },
          ),
      )
      .min(1)
      .max(64),
    order: z
      .string()
      .trim()
      .regex(/^-?\d{1,4}$/, { error: "order must be an integer" })
      .transform(Number)
      .optional(),
    description: z.string().trim().min(1).max(500).optional(),
  })
  .strict()

type ParsedDocument = {
  readonly fields: Record<string, string | string[]>
  readonly body: string
}

function splitFrontmatter(
  text: string,
): { readonly ok: true; readonly value: ParsedDocument } | { readonly ok: false; reason: string } {
  const lines = text.replaceAll("\r\n", "\n").split("\n")
  if (lines[0]?.trim() !== "---") return { ok: false, reason: "missing opening frontmatter fence" }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (end < 0) return { ok: false, reason: "missing closing frontmatter fence" }
  const fields: Record<string, string | string[]> = {}
  let currentKey: string | null = null
  for (const line of lines.slice(1, end)) {
    if (line.trim().length === 0) continue
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item !== null) {
      const value = fields[currentKey ?? ""]
      if (currentKey === null || !Array.isArray(value)) {
        return { ok: false, reason: "list item without a preceding key" }
      }
      value.push(unquote(item[1] ?? ""))
      continue
    }
    const pair = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (pair === null || pair[1] === undefined) {
      return { ok: false, reason: `unparsable frontmatter line: ${line.trim()}` }
    }
    currentKey = pair[1]
    if (currentKey in fields)
      return { ok: false, reason: `duplicate frontmatter key: ${currentKey}` }
    const raw = (pair[2] ?? "").trim()
    if (raw.length === 0) {
      fields[currentKey] = []
      continue
    }
    if (raw.startsWith("[")) {
      const inline = parseInlineList(raw)
      if (inline === null) return { ok: false, reason: `unparsable inline list for ${currentKey}` }
      fields[currentKey] = inline
      continue
    }
    fields[currentKey] = unquote(raw)
  }
  return {
    ok: true,
    value: {
      fields,
      body: lines
        .slice(end + 1)
        .join("\n")
        .trim(),
    },
  }
}

function unquote(value: string): string {
  const trimmed = value.trim()
  const quoted = /^(["'])(.*)\1$/.exec(trimmed)
  return quoted?.[2] ?? trimmed
}

function parseInlineList(raw: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(raw.replaceAll("\\", "\\\\"))
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) return null
    return parsed as string[]
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

function parseRule(options: {
  readonly fileName: string
  readonly relativePath: string
  readonly displayPath: string
  readonly text: string
  readonly bytes: number
}): RuleResult {
  const document = splitFrontmatter(options.text)
  if (!document.ok) {
    return {
      ok: false,
      error: new RuleDiscoveryError(
        "malformed_rule_frontmatter",
        `${options.fileName}: ${document.reason}`,
      ),
    }
  }
  const frontmatter = RuleFrontmatterSchema.safeParse(document.value.fields)
  if (!frontmatter.success) {
    return {
      ok: false,
      error: new RuleDiscoveryError(
        "malformed_rule_frontmatter",
        `${options.fileName}: ${frontmatter.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`,
      ),
    }
  }
  return {
    ok: true,
    value: {
      fileName: options.fileName,
      relativePath: options.relativePath,
      displayPath: options.displayPath,
      globs: frontmatter.data.globs,
      order: frontmatter.data.order ?? null,
      description: frontmatter.data.description ?? null,
      body: document.value.body,
      bytes: options.bytes,
    },
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

type RootResolution =
  | { readonly ok: true; readonly repositoryReal: string; readonly rulesReal: string }
  | { readonly ok: false; readonly error: RuleDiscoveryError }
  | { readonly ok: "absent" }

async function resolveRulesRoot(repositoryRoot: string): Promise<RootResolution> {
  const rulesRoot = rulesRootPath(repositoryRoot)
  try {
    const repositoryReal = await realpath(platformPath(repositoryRoot))
    const rulesReal = await realpath(rulesRoot)
    if (
      !isCanonicalPathContained(
        canonicalComparisonPath(repositoryReal),
        canonicalComparisonPath(rulesReal),
      )
    ) {
      return {
        ok: false,
        error: new RuleDiscoveryError(
          "rules_root_escaped",
          `${normalizeRuleSeparators(rulesRoot)} resolves outside the repository`,
        ),
      }
    }
    return { ok: true, repositoryReal, rulesReal }
  } catch (error) {
    if (isMissing(error)) return { ok: "absent" }
    if (error instanceof Error) {
      return {
        ok: false,
        error: new RuleDiscoveryError(
          "rules_root_unreadable",
          `${normalizeRuleSeparators(rulesRoot)} is unreadable`,
        ),
      }
    }
    throw error
  }
}

async function loadRule(rulesReal: string, fileName: string): Promise<RuleResult> {
  const candidate = join(rulesReal, fileName)
  const failure = (code: RuleDiscoveryCode, reason: string): RuleResult => ({
    ok: false,
    error: new RuleDiscoveryError(code, `${fileName}: ${reason}`),
  })
  try {
    const entry = await lstat(candidate)
    if (entry.isSymbolicLink()) return failure("rule_link_rejected", "entry is a link or junction")
    if (!entry.isFile()) return failure("rule_not_regular_file", "entry is not a regular file")
    if (entry.size > MAX_RULE_BYTES) return failure("rule_too_large", `${entry.size} bytes`)
    const candidateReal = await realpath(candidate)
    if (
      !isCanonicalPathContained(
        canonicalComparisonPath(rulesReal),
        canonicalComparisonPath(candidateReal),
      )
    ) {
      return failure("rule_path_escaped", "resolves outside the rules directory")
    }
    const handle = await open(candidateReal, "r")
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.size !== entry.size) {
        return failure("rule_unreadable", "file changed while reading")
      }
      const bytes = await handle.readFile()
      return parseRule({
        fileName,
        relativePath: `.omo/rules/${fileName}`,
        displayPath: candidateReal,
        text: new TextDecoder().decode(bytes),
        bytes: bytes.byteLength,
      })
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error instanceof Error) return failure("rule_unreadable", "file is unreadable")
    throw error
  }
}

function rejectedName(fileName: string): RuleDiscoveryError | null {
  const normalized = normalizeRuleSeparators(fileName)
  if (
    normalized !== fileName ||
    normalized.includes("/") ||
    normalized === "." ||
    normalized === ".." ||
    isAbsolute(normalized) ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.includes("\u0000")
  ) {
    return new RuleDiscoveryError(
      "rule_path_escaped",
      `${fileName}: rule names must be flat file names inside .omo/rules`,
    )
  }
  return normalized.endsWith(RULE_EXTENSION)
    ? null
    : new RuleDiscoveryError("rule_not_regular_file", `${fileName}: not a ${RULE_EXTENSION} rule`)
}

/** Reads one flat `.omo/rules/<name>.md` rule, refusing any escaping or linked path. */
export async function readRepositoryRule(
  repositoryRoot: string,
  fileName: string,
): Promise<RuleResult> {
  const nameError = rejectedName(fileName)
  if (nameError !== null) return { ok: false, error: nameError }
  const root = await resolveRulesRoot(repositoryRoot)
  if (root.ok === "absent") {
    return {
      ok: false,
      error: new RuleDiscoveryError("rules_root_unreadable", `${fileName}: .omo/rules is absent`),
    }
  }
  if (!root.ok) return { ok: false, error: root.error }
  return loadRule(root.rulesReal, fileName)
}

function compareNames(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}

/** Discovers `<repository>/.omo/rules/*.md` in sorted order without walking outside it. */
export async function discoverRepositoryRules(
  repositoryRoot: string,
): Promise<RulesDiscoveryResult> {
  const root = await resolveRulesRoot(repositoryRoot)
  if (root.ok === "absent") {
    return { ok: true, rulesRoot: rulesRootPath(repositoryRoot), rules: [], rejections: [] }
  }
  if (!root.ok) return { ok: false, error: root.error }
  const names = (await readdir(root.rulesReal))
    .filter((name) => name.endsWith(RULE_EXTENSION))
    .sort(compareNames)
  const rules: DiscoveredRule[] = []
  const rejections: RuleRejection[] = []
  for (const fileName of names) {
    const nameError = rejectedName(fileName)
    if (nameError !== null) {
      rejections.push({ fileName, error: nameError })
      continue
    }
    const rule = await loadRule(root.rulesReal, fileName)
    if (rule.ok) rules.push(rule.value)
    else rejections.push({ fileName, error: rule.error })
  }
  return { ok: true, rulesRoot: normalizeRuleSeparators(root.rulesReal), rules, rejections }
}
