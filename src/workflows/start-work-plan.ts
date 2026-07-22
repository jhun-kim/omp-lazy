export type PlanSnapshot = {
  readonly taskIds: readonly string[]
  readonly remainingTaskIds: readonly string[]
  readonly fingerprint: string
}

export type NormalizedPlan = PlanSnapshot & {
  readonly version: 1 | 2
}

export type NormalizePlanResult =
  | { readonly ok: true; readonly value: NormalizedPlan }
  | {
      readonly ok: false
      readonly code: "plan_identity_mismatch" | "duplicate_normalized_task_identity"
    }

const V1_MARKER = "<!-- omp-lazy-ulw-plan:plan:v1 -->"
const V2_MARKER = "<!-- omp-lazy-ulw-plan:plan:v2 -->"
const V1_HEADINGS = ["## TODOs", "## Final Verification Wave"] as const
const V2_HEADINGS = [
  "## TL;DR (For humans)",
  "## Scope",
  "## Verification strategy",
  "## Execution strategy",
  "## Todos",
  "## Final verification wave",
  "## Commit strategy",
  "## Success criteria",
] as const
const EXPLICIT_ID = /^\*\*([A-Z][A-Z0-9-]{0,31})\. (.{1,200})\*\*$/u

type Section = "todos" | "final"

type ChecklistLine = {
  readonly id: string
  readonly checked: boolean
  readonly section: Section
  readonly explicit: boolean
}

function legacyId(line: string): string {
  const neutralized = line.normalize("NFC").replace(/^(- \[)[ xX](\])/, "$1 $2")
  return `LEGACY-${createHash("sha256").update(neutralized).digest("hex").slice(0, 12)}`
}

function v2HeadingsAreOrdered(lines: readonly string[]): boolean {
  if (V2_HEADINGS.some((heading) => lines.filter((line) => line === heading).length !== 1)) {
    return false
  }
  let position = 0
  for (const line of lines) {
    if (line === V2_HEADINGS[position]) position += 1
  }
  return position === V2_HEADINGS.length
}

function selectedSection(line: string, version: 1 | 2): Section | null | undefined {
  const headings = version === 1 ? V1_HEADINGS : [V2_HEADINGS[4], V2_HEADINGS[5]]
  if (line === headings[0]) return "todos"
  if (line === headings[1]) return "final"
  return line.startsWith("## ") ? null : undefined
}

function parseChecklist(
  lines: readonly string[],
  version: 1 | 2,
  assignsLegacyIds: boolean,
): readonly ChecklistLine[] {
  const tasks: ChecklistLine[] = []
  let section: Section | null = null
  for (const line of lines) {
    const nextSection = selectedSection(line, version)
    if (nextSection !== undefined) {
      section = nextSection
      continue
    }
    if (section === null) continue
    const match = /^- \[([ xX])\] (.+?)\s*$/u.exec(line)
    const mark = match?.[1]
    const label = match?.[2]
    if (mark === undefined || label === undefined) continue
    const explicit = EXPLICIT_ID.exec(label.normalize("NFC"))
    const id =
      explicit?.[1] ?? (assignsLegacyIds ? legacyId(line) : label.trim().replace(/\s+/g, " "))
    tasks.push({ id, checked: mark !== " ", section, explicit: explicit !== null })
  }
  return tasks
}

export function normalizeStartWorkPlan(markdown: string): NormalizePlanResult {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n")
  const hasV1Marker = lines.includes(V1_MARKER)
  const version = lines.includes(V2_MARKER) ? 2 : 1
  if (version === 2 && !v2HeadingsAreOrdered(lines)) {
    return { ok: false, code: "plan_identity_mismatch" }
  }
  const tasks = parseChecklist(lines, version, hasV1Marker)
  if (version === 2 && tasks.some((task) => !task.explicit)) {
    return { ok: false, code: "plan_identity_mismatch" }
  }
  const identities = tasks.map((task) => ({ section: task.section, id: task.id }))
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
    return { ok: false, code: "duplicate_normalized_task_identity" }
  }
  return {
    ok: true,
    value: {
      version,
      taskIds: tasks.map((task) => task.id),
      remainingTaskIds: tasks.filter((task) => !task.checked).map((task) => task.id),
      fingerprint: createHash("sha256").update(JSON.stringify(identities)).digest("hex"),
    },
  }
}

export function parseStartWorkPlan(_markdown: string): PlanSnapshot {
  const normalized = normalizeStartWorkPlan(_markdown)
  if (!normalized.ok) return { taskIds: [], remainingTaskIds: [], fingerprint: "" }
  return normalized.value
}

import { createHash } from "node:crypto"
