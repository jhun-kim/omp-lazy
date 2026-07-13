export type PlanSnapshot = {
  readonly taskIds: readonly string[]
  readonly remainingTaskIds: readonly string[]
  readonly fingerprint: string
}

export function parseStartWorkPlan(_markdown: string): PlanSnapshot {
  type Section = "todos" | "final"
  const taskIds: string[] = []
  const remainingTaskIds: string[] = []
  const identities: { readonly section: Section; readonly id: string }[] = []
  let section: Section | null = null
  for (const line of _markdown.split(/\r?\n/)) {
    if (line === "## TODOs") {
      section = "todos"
      continue
    }
    if (line === "## Final Verification Wave") {
      section = "final"
      continue
    }
    if (line.startsWith("## ")) {
      section = null
      continue
    }
    if (section === null) continue
    const match = /^- \[([ xX])\] (.+?)\s*$/.exec(line)
    const mark = match?.[1]
    const label = match?.[2]
    if (mark === undefined || label === undefined) continue
    const id = label.trim().replace(/\s+/g, " ")
    taskIds.push(id)
    identities.push({ section, id })
    if (mark === " ") remainingTaskIds.push(id)
  }
  const fingerprint = createHash("sha256").update(JSON.stringify(identities)).digest("hex")
  return { taskIds, remainingTaskIds, fingerprint }
}

import { createHash } from "node:crypto"
