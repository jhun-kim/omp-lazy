import type { WorkflowActivationId } from "../activation/types"
import { COMMAND_DEFINITIONS } from "./command-definitions"

export type ParsedWorkflowCommand =
  | { readonly ok: true; readonly operation: string; readonly words: readonly string[] }
  | { readonly ok: false; readonly code: "invalid_grammar" }

const valid = (operation: string, words: readonly string[]): ParsedWorkflowCommand => ({
  ok: true,
  operation,
  words,
})
const invalid = (): ParsedWorkflowCommand => ({ ok: false, code: "invalid_grammar" })

function tokenize(args: string): readonly string[] | null {
  const words: string[] = []
  let index = 0
  while (index < args.length) {
    while (/\s/u.test(args[index] ?? "")) index += 1
    if (index >= args.length) break
    const quote = args[index] === '"' || args[index] === "'" ? args[index] : null
    const start = quote === null ? index : index + 1
    let end = start
    while (
      end < args.length &&
      (quote === null ? !/\s/u.test(args[end] ?? "") : args[end] !== quote)
    ) {
      end += 1
    }
    if (quote !== null && end >= args.length) return null
    if (end === start) return null
    words.push(args.slice(start, end))
    index = quote === null ? end : end + 1
    if (index < args.length && !/\s/u.test(args[index] ?? "")) return null
  }
  return words
}

function tokensFollowCatalogGrammar(
  workflow: WorkflowActivationId,
  words: readonly string[],
): boolean {
  const definition = COMMAND_DEFINITIONS.find((candidate) => candidate.workflow === workflow)
  if (definition === undefined) return false
  const grammar = definition.grammar.join(" ")
  const allowedFlags = new Set([...grammar.matchAll(/--[a-z][a-z-]*/gu)].map((match) => match[0]))
  const acceptsDelimiter = grammar.includes("-- <")
  let afterDelimiter = false
  for (const word of words) {
    if (word === "--") {
      if (!acceptsDelimiter || afterDelimiter) return false
      afterDelimiter = true
    } else if (!afterDelimiter && word.startsWith("--") && !allowedFlags.has(word)) {
      return false
    }
  }
  return true
}

function parseStart(words: readonly string[]): ParsedWorkflowCommand {
  const [operation, ...rest] = words
  if (operation === undefined) return valid("start", [])
  if (operation === "start" && rest.length <= 1) return valid(operation, rest)
  if (["pause", "resume", "cancel"].includes(operation) && rest.length <= 1) {
    return valid(operation, rest)
  }
  if (operation === "adopt" && rest.length === 1) return valid(operation, rest)
  if (operation === "reconcile" && rest.length === 2) return valid(operation, rest)
  if (operation !== "status") return invalid()
  if (rest.length <= 1) return valid(operation, rest)
  if (rest[0] === "--repair" && rest.length === 2) return valid("repair", rest.slice(1))
  if (rest[0] === "--repair-lock" && rest.length === 3 && rest[2] === "--confirm") {
    return valid("repair_lock", [rest[1] ?? ""])
  }
  return invalid()
}

function parseUlwLoop(words: readonly string[]): ParsedWorkflowCommand {
  const operation = words[0]
  const rest = words.slice(1)
  if (operation === "create" && rest.length > 0) return valid(operation, rest)
  if (["status", "pause", "resume", "cancel"].includes(operation ?? "") && rest.length <= 1) {
    return valid(operation ?? "", rest)
  }
  if (operation === "adopt" && rest.length === 1) return valid(operation, rest)
  if (operation === "checkpoint" && rest.length === 3) return valid(operation, rest)
  return operation === "steer" && rest.length === 2 ? valid(operation, rest) : invalid()
}

function parseReport(words: readonly string[]): ParsedWorkflowCommand {
  let index = 0
  while (index < words.length && (words[index] ?? "").startsWith("--")) {
    if (words[index] === "--dry-run") index += 1
    else if (
      words[index] === "--target" &&
      ["auto", "omp-lazy", "omp"].includes(words[index + 1] ?? "")
    ) {
      index += 2
    } else return invalid()
  }
  const summary = words.slice(index)
  return summary.length > 0 && summary.every((word) => !word.startsWith("--"))
    ? valid("draft", summary)
    : invalid()
}

export function parseWorkflowCommand(
  workflow: WorkflowActivationId,
  args: string,
): ParsedWorkflowCommand {
  const words = tokenize(args.trim())
  if (words === null || !tokensFollowCatalogGrammar(workflow, words)) return invalid()
  switch (workflow) {
    case "start_work":
      return parseStart(words)
    case "ulw_loop":
      return parseUlwLoop(words)
    case "teammode": {
      const operation = words[0]
      const rest = words.slice(1)
      if (operation === "status" && rest.length <= 1) return valid(operation, rest)
      if ((operation === "prepare" || operation === "create") && rest.length === 2) {
        return valid(operation, rest)
      }
      return ["cancel", "archive", "delete", "resume"].includes(operation ?? "") &&
        rest.length === 1
        ? valid(operation ?? "", rest)
        : invalid()
    }
    case "ultrawork": {
      const separator = words.indexOf("--")
      const modes = separator < 0 ? words : words.slice(0, separator)
      const task = separator < 0 ? [] : words.slice(separator + 1)
      return modes.length <= 1 &&
        [undefined, "auto", "light", "heavy"].includes(modes[0]) &&
        (separator < 0 || task.length > 0)
        ? valid("activate", words)
        : invalid()
    }
    case "ulw_plan":
      if (words[0] === "approve") {
        return words.length === 3 && /^[0-9a-f]{64}$/u.test(words[2] ?? "")
          ? valid("approve", words.slice(1))
          : invalid()
      }
      return words.length === 0 || (words[0] === "--" && words.length > 1)
        ? valid("plan", words.slice(1))
        : invalid()
    case "ulw_research":
      return words.length > 0 && !words[0]?.startsWith("--") ? valid("research", words) : invalid()
    case "doctor":
      return words.every((word) => word === "--json" || word === "--deep") &&
        new Set(words).size === words.length
        ? valid("doctor", words)
        : invalid()
    case "report_bug":
      return parseReport(words)
    case "contribute_bug_fix":
      return words[0] === "--dry-run" && words.length === 2
        ? valid("dry_run", words.slice(1))
        : invalid()
    default:
      return workflow satisfies never
  }
}

export class CommandSyntaxError extends Error {
  readonly name = "CommandSyntaxError"
  constructor(readonly command: string) {
    super(`invalid grammar for ${command}`)
  }
}
