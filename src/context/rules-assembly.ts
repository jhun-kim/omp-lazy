/**
 * Budget-bounded deterministic rule assembly.
 *
 * Matches discovered rules against working paths, orders deterministically,
 * and assembles text under hard byte caps. Priority on overflow:
 * latest user turn > active directive > skill/directive catalog > rules.
 * The lowest-priority WHOLE unit is dropped first.
 */

/** Total injection budget in UTF-8 bytes after assembly. */
export const INJECTION_BUDGET_BYTES = 65536

/** Budget for the active workflow directive section. */
export const DIRECTIVE_BUDGET_BYTES = 32768

/** Budget for matched repository rules. */
export const RULES_BUDGET_BYTES = 20480

/** Budget for the skill/directive catalog section. */
export const CATALOG_BUDGET_BYTES = 12288

export type RuleUnit = {
  readonly fileName: string
  readonly relativePath: string
  readonly displayPath: string
  readonly globs: readonly string[]
  readonly order: number | null
  readonly description: string | null
  readonly body: string
  readonly bytes: number
}

export type AssemblyInput = {
  readonly rules: readonly RuleUnit[]
  readonly touchedPaths: readonly string[]
  readonly directiveText: string | null
  readonly catalogText: string | null
}

export type DroppedUnit = {
  readonly id: string
  readonly section: "rules" | "directive" | "catalog"
  readonly reason: string
}

export type RetainedUnit = {
  readonly id: string
  readonly section: "rules" | "directive" | "catalog"
}

export type AssemblyResult = {
  readonly assembledRules: string | null
  readonly assembledDirective: string | null
  readonly assembledCatalog: string | null
  readonly totalBytes: number
  readonly droppedUnits: readonly DroppedUnit[]
  readonly retainedUnits: readonly RetainedUnit[]
}

// ---------------------------------------------------------------------------
// Glob matching (in-repo, no external dependency)
// ---------------------------------------------------------------------------

/**
 * Normalizes a path to use forward slashes for uniform matching.
 */
function normalizePath(path: string): string {
  return path.replaceAll("\\", "/")
}

/**
 * Matches a glob pattern against a path. Supports:
 * - `**` matches zero or more directory segments (including none)
 * - `*` matches any characters within a single segment (no `/`)
 * - `?` matches exactly one character (not `/`)
 *
 * Both path and glob are normalized to forward slashes before matching.
 */
export function matchGlob(glob: string, path: string): boolean {
  const normalizedGlob = normalizePath(glob)
  const normalizedPath = normalizePath(path)
  return globMatchImpl(normalizedGlob.split("/"), normalizedPath.split("/"), 0, 0)
}

function globMatchImpl(
  globParts: string[],
  pathParts: string[],
  startGi: number,
  startPi: number,
): boolean {
  let gi = startGi
  let pi = startPi
  while (gi < globParts.length && pi < pathParts.length) {
    const gPart = globParts[gi]
    if (gPart === undefined) break
    if (gPart === "**") {
      // ** can match zero or more path segments
      // Try matching zero segments (skip the **) ...
      if (globMatchImpl(globParts, pathParts, gi + 1, pi)) return true
      // ... or consume one more path segment and try again
      return globMatchImpl(globParts, pathParts, gi, pi + 1)
    }
    const pPart = pathParts[pi]
    if (pPart === undefined || !segmentMatch(gPart, pPart)) return false
    gi++
    pi++
  }
  // Consume trailing ** patterns that match nothing
  while (gi < globParts.length && globParts[gi] === "**") gi++
  return gi === globParts.length && pi === pathParts.length
}

/**
 * Matches a single path segment against a glob segment with `*` and `?`.
 */
function segmentMatch(pattern: string, segment: string): boolean {
  let pi = 0
  let si = 0
  let starPi = -1
  let starSi = -1

  while (si < segment.length) {
    if (pi < pattern.length && (pattern[pi] === "?" || pattern[pi] === segment[si])) {
      pi++
      si++
    } else if (pi < pattern.length && pattern[pi] === "*") {
      starPi = pi
      starSi = si
      pi++
    } else if (starPi >= 0) {
      pi = starPi + 1
      starSi++
      si = starSi
    } else {
      return false
    }
  }
  while (pi < pattern.length && pattern[pi] === "*") pi++
  return pi === pattern.length
}

// ---------------------------------------------------------------------------
// Ordering and assembly
// ---------------------------------------------------------------------------

/**
 * Computes the specificity of a glob pattern. More path-literal characters
 * (non-wildcard, non-separator) means higher specificity.
 */
function globSpecificity(globs: readonly string[]): number {
  let max = 0
  for (const glob of globs) {
    const normalized = normalizePath(glob)
    // Count non-wildcard characters excluding separators
    let score = 0
    for (const ch of normalized) {
      if (ch !== "*" && ch !== "?" && ch !== "/") score++
    }
    if (score > max) max = score
  }
  return max
}

type ScoredRule = {
  readonly rule: RuleUnit
  readonly order: number
  readonly specificity: number
}

function compareRules(a: ScoredRule, b: ScoredRule): number {
  // Lower order number = higher priority (appears first)
  if (a.order !== b.order) return a.order - b.order
  // Higher specificity = higher priority (appears first)
  if (a.specificity !== b.specificity) return b.specificity - a.specificity
  // Lexicographic filename as final tiebreaker
  if (a.rule.fileName < b.rule.fileName) return -1
  if (a.rule.fileName > b.rule.fileName) return 1
  return 0
}

/**
 * Assembles rules under hard byte budgets.
 *
 * Priority on overflow (highest to lowest):
 * 1. Latest user turn (not part of this assembly - always retained by host)
 * 2. Active directive
 * 3. Skill/directive catalog
 * 4. Rules
 *
 * The lowest-priority WHOLE unit is dropped first when a cap is hit.
 */
export function assembleRules(input: AssemblyInput): AssemblyResult {
  const droppedUnits: DroppedUnit[] = []
  const retainedUnits: RetainedUnit[] = []

  // --- 1. Filter and sort rules by path matching ---
  const matchedRules = filterMatchingRules(input.rules, input.touchedPaths)
  const sortedRules = sortRules(matchedRules)

  // --- 2. Assemble each section under its own cap ---

  // Directive section (highest priority of the three)
  let assembledDirective: string | null = null
  if (input.directiveText !== null) {
    const directiveBytes = Buffer.byteLength(input.directiveText, "utf8")
    if (directiveBytes <= DIRECTIVE_BUDGET_BYTES) {
      assembledDirective = input.directiveText
      retainedUnits.push({ id: "directive", section: "directive" })
    } else {
      // Directive exceeds its section cap - drop it entirely
      assembledDirective = null
      droppedUnits.push({
        id: "directive",
        section: "directive",
        reason: `directive exceeds DIRECTIVE_BUDGET_BYTES (${directiveBytes} > ${DIRECTIVE_BUDGET_BYTES})`,
      })
    }
  }

  // Catalog section (middle priority)
  let assembledCatalog: string | null = null
  if (input.catalogText !== null) {
    const catalogBytes = Buffer.byteLength(input.catalogText, "utf8")
    if (catalogBytes <= CATALOG_BUDGET_BYTES) {
      assembledCatalog = input.catalogText
      retainedUnits.push({ id: "catalog", section: "catalog" })
    } else {
      // Catalog exceeds its section cap - drop it entirely
      assembledCatalog = null
      droppedUnits.push({
        id: "catalog",
        section: "catalog",
        reason: `catalog exceeds CATALOG_BUDGET_BYTES (${catalogBytes} > ${CATALOG_BUDGET_BYTES})`,
      })
    }
  }

  // Rules section (lowest priority) - assemble greedily in priority order
  let assembledRules: string | null = null
  const ruleSegments: string[] = []
  let currentRulesBytes = 0

  for (const scored of sortedRules) {
    const ruleText = formatRuleEntry(scored.rule)
    const ruleBytes = Buffer.byteLength(ruleText, "utf8")
    const separatorBytes = ruleSegments.length > 0 ? Buffer.byteLength("\n\n", "utf8") : 0

    if (currentRulesBytes + separatorBytes + ruleBytes <= RULES_BUDGET_BYTES) {
      ruleSegments.push(ruleText)
      currentRulesBytes += separatorBytes + ruleBytes
      retainedUnits.push({ id: scored.rule.fileName, section: "rules" })
    } else {
      droppedUnits.push({
        id: scored.rule.fileName,
        section: "rules",
        reason: `rules budget exceeded (would be ${currentRulesBytes + separatorBytes + ruleBytes} > ${RULES_BUDGET_BYTES})`,
      })
    }
  }

  if (ruleSegments.length > 0) {
    assembledRules = ruleSegments.join("\n\n")
  }

  // --- 3. Check total budget and drop lowest-priority sections if needed ---
  const totalBytes =
    Buffer.byteLength(assembledDirective ?? "", "utf8") +
    Buffer.byteLength(assembledCatalog ?? "", "utf8") +
    Buffer.byteLength(assembledRules ?? "", "utf8")

  // The per-section caps already guarantee sub-budgets sum to INJECTION_BUDGET_BYTES,
  // so total can never exceed it if each section respects its own cap.
  // But we enforce the total as a final safety check.
  if (totalBytes > INJECTION_BUDGET_BYTES) {
    // This should not happen given the per-section caps sum to the total,
    // but guard defensively by dropping rules first, then catalog.
    if (assembledRules !== null) {
      for (const retained of [...retainedUnits].filter((u) => u.section === "rules").reverse()) {
        droppedUnits.push({
          id: retained.id,
          section: "rules",
          reason: "total budget overflow safety",
        })
      }
      retainedUnits.splice(
        0,
        retainedUnits.length,
        ...retainedUnits.filter((u) => u.section !== "rules"),
      )
      assembledRules = null
    }
  }

  return {
    assembledRules,
    assembledDirective,
    assembledCatalog,
    totalBytes:
      Buffer.byteLength(assembledDirective ?? "", "utf8") +
      Buffer.byteLength(assembledCatalog ?? "", "utf8") +
      Buffer.byteLength(assembledRules ?? "", "utf8"),
    droppedUnits,
    retainedUnits,
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function filterMatchingRules(
  rules: readonly RuleUnit[],
  touchedPaths: readonly string[],
): RuleUnit[] {
  return rules.filter((rule) =>
    rule.globs.some((glob) => touchedPaths.some((path) => matchGlob(glob, path))),
  )
}

function sortRules(rules: RuleUnit[]): ScoredRule[] {
  const scored: ScoredRule[] = rules.map((rule) => ({
    rule,
    order: rule.order ?? 0,
    specificity: globSpecificity(rule.globs),
  }))
  scored.sort(compareRules)
  return scored
}

function formatRuleEntry(rule: RuleUnit): string {
  const header = `[${rule.fileName}]`
  return `${header}\n${rule.body}`
}
