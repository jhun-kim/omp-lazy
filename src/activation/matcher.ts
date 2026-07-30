import { COMMAND_REGISTRATIONS, type CommandRegistration } from "../commands/command-definitions"

const PROTECTED_BOUNDARY = "\\p{L}\\p{N}_.\\\\/-"

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function matchesToken(text: string, command: string): boolean {
  const name = escapeRegex(command.slice(1))
  const expression = new RegExp(
    `(?<![${PROTECTED_BOUNDARY}])(?:/)?${name}(?![${PROTECTED_BOUNDARY}])`,
    "iu",
  )
  return expression.test(text)
}

/**
 * Bare trigger tokens that activate a workflow without requiring the full
 * command name (e.g. `ultrawork` or `ulw`). Case-insensitive, whole-token only.
 */
type TriggerEntry = {
  readonly token: string
  readonly workflow: CommandRegistration
}

const TRIGGER_ALLOWLIST: readonly TriggerEntry[] = buildTriggerAllowlist()

function buildTriggerAllowlist(): TriggerEntry[] {
  const ultraworkReg = COMMAND_REGISTRATIONS.find(
    (reg) => reg.command === "/omp-lazy-ultrawork(omp)",
  )
  if (!ultraworkReg) return []
  return [
    { token: "ultrawork", workflow: ultraworkReg },
    { token: "ulw", workflow: ultraworkReg },
  ]
}

/**
 * Strip fenced code blocks (``` ... ```) from the text before tokenization
 * so that trigger tokens inside code fences are never matched.
 */
function stripFencedCodeBlocks(text: string): string {
  return text.replace(/^```[^\n]*\n[\s\S]*?^```/gm, "")
}

/**
 * Strip quoted strings (double, single, and backtick) from the text before
 * tokenization so that trigger tokens inside quoted paths are never matched.
 */
function stripQuotedStrings(text: string): string {
  return text.replace(/`[^`]*`|"[^"]*"|'[^']*'/g, "")
}

/**
 * Tokenize text by splitting on whitespace and punctuation boundaries.
 * Returns individual word tokens.
 */
function tokenize(text: string): string[] {
  // Split on whitespace and common punctuation (keeping alphanumeric tokens)
  return text.split(/[\s,;:!?(){}[\]<>]+/).filter((t) => t.length > 0)
}

/**
 * Check if a token matches a trigger EXACTLY (whole-token, case-insensitive).
 * The token must be the entire match — no substring matching.
 */
function matchesTriggerExact(token: string, trigger: string): boolean {
  return token.toLowerCase() === trigger.toLowerCase()
}

function matchTriggerAllowlist(text: string): CommandRegistration | null {
  // Strip fenced code blocks and quoted strings before tokenization
  const cleaned = stripQuotedStrings(stripFencedCodeBlocks(text))
  const tokens = tokenize(cleaned)

  const matches: CommandRegistration[] = []
  for (const entry of TRIGGER_ALLOWLIST) {
    for (const token of tokens) {
      if (matchesTriggerExact(token, entry.token)) {
        matches.push(entry.workflow)
        break
      }
    }
  }

  if (matches.length === 0) return null
  // All trigger entries for bare tokens map to the same workflow (ultrawork)
  const workflows = new Set(matches.map((m) => m.workflow))
  return workflows.size === 1 ? (matches[0] ?? null) : null
}

export function matchActivation(text: string): CommandRegistration | null {
  // First try exact command-name matching (existing behavior)
  const commandMatches = COMMAND_REGISTRATIONS.filter((registration) =>
    matchesToken(text, registration.command),
  )
  if (commandMatches.length > 0) {
    const workflows = new Set(commandMatches.map((match) => match.workflow))
    return workflows.size === 1 ? (commandMatches[0] ?? null) : null
  }

  // Only try the bare trigger allowlist when NO command names matched at all
  return matchTriggerAllowlist(text)
}
