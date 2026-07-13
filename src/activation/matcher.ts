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

export function matchActivation(text: string): CommandRegistration | null {
  const matches = COMMAND_REGISTRATIONS.filter((registration) =>
    matchesToken(text, registration.command),
  )
  if (matches.length === 0) return null
  const workflows = new Set(matches.map((match) => match.workflow))
  return workflows.size === 1 ? (matches[0] ?? null) : null
}
