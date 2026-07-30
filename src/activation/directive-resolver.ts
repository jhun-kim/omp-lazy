/**
 * Resolves a workflow activation to its corresponding skill directive text.
 *
 * Reads `skills/<skillName>/SKILL.md`, compacts the text through the
 * catalog-compaction budget path, and wraps it in the stable delimiter:
 * `<omp-lazy-directive workflow="..." skill="...">` ... `</omp-lazy-directive>`.
 *
 * Hard invariants:
 * - Only reads files under `skills/` in the extension root.
 * - Emits at most one directive section per call.
 * - A read failure yields `null` (degradation), never throws.
 */

import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { DIRECTIVE_BUDGET_BYTES } from "../context/rules-assembly"
import type { WorkflowActivationId } from "./types"

/**
 * Maps workflow activation IDs to their corresponding skill directory names.
 * This is the canonical source-of-truth for the workflow → skill mapping.
 */
const WORKFLOW_SKILL_MAP: Readonly<Record<WorkflowActivationId, string>> = {
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
}

export type DirectiveResolution = {
  readonly kind: "resolved"
  readonly workflow: WorkflowActivationId
  readonly skill: string
  readonly text: string
  readonly bytes: number
}

export type DirectiveDegradation = {
  readonly kind: "degraded"
  readonly workflow: WorkflowActivationId
  readonly skill: string
  readonly reason: string
}

export type DirectiveResult = DirectiveResolution | DirectiveDegradation

/**
 * Resolves a workflow to its directive text from the skill file.
 *
 * @param workflow - The workflow activation ID.
 * @param extensionRoot - The root of the extension (where `skills/` lives).
 * @returns The resolved directive or a degradation record.
 */
export async function resolveDirective(
  workflow: WorkflowActivationId,
  extensionRoot: string,
): Promise<DirectiveResult> {
  const skill = WORKFLOW_SKILL_MAP[workflow]
  const skillPath = join(extensionRoot, "skills", skill, "SKILL.md")

  // Containment: ensure the resolved path is within skills/
  const resolved = resolve(skillPath)
  const skillsRoot = resolve(join(extensionRoot, "skills"))
  if (!resolved.startsWith(skillsRoot)) {
    return {
      kind: "degraded",
      workflow,
      skill,
      reason: "path_escape_rejected",
    }
  }

  let rawText: string
  try {
    rawText = await readFile(resolved, "utf-8")
  } catch (error: unknown) {
    const code =
      error instanceof Error && "code" in error ? (error as { code: string }).code : "unknown"
    return {
      kind: "degraded",
      workflow,
      skill,
      reason: `skill_file_unreadable: ${code}`,
    }
  }

  // Compact under the directive budget
  const bytes = Buffer.byteLength(rawText, "utf-8")
  if (bytes > DIRECTIVE_BUDGET_BYTES) {
    // Truncate at byte boundary without breaking UTF-8
    const encoder = new TextEncoder()
    const encoded = encoder.encode(rawText)
    const decoder = new TextDecoder("utf-8", { fatal: false })
    rawText = decoder.decode(encoded.slice(0, DIRECTIVE_BUDGET_BYTES)).replace(/\uFFFD$/, "")
  }

  return {
    kind: "resolved",
    workflow,
    skill,
    text: rawText,
    bytes: Buffer.byteLength(rawText, "utf-8"),
  }
}

/**
 * Wraps resolved directive text in the stable delimiter.
 */
export function wrapDirective(resolution: DirectiveResolution): string {
  return `<omp-lazy-directive workflow="${resolution.workflow}" skill="${resolution.skill}">\n${resolution.text}\n</omp-lazy-directive>`
}
