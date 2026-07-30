import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent"
import { sanitizeStatusText, type UIDegradation } from "./sanitize-status-text"

export { STATUS_TEXT_MAX, sanitizeStatusText, type UIDegradation } from "./sanitize-status-text"

/**
 * Namespaced key used with `ctx.ui.setStatus`.
 * A single key is used across the extension — only one active-run status line
 * is meaningful at a time.
 */
export const STATUS_KEY = "omp-lazy:run"

/**
 * Composes the single-line status string showing active workflow, run id,
 * plan/goal progress and the current model role.
 *
 * Format: `[workflow] run-short progress | role`
 * Examples:
 *   `[start_work] a1b2c3d4 3/7 | @slow`
 *   `[ulw_loop] f9e8d7c6 2/4 goals | @task`
 *   `[start_work] a1b2c3d4 active | @smol`
 */
export function composeStatusLine(input: StatusLineInput): string {
  const parts: string[] = []
  parts.push(`[${input.workflow}]`)
  parts.push(input.runIdShort)
  parts.push(input.progress)
  if (input.modelRole !== null) {
    parts.push(`| ${input.modelRole}`)
  }
  return parts.join(" ")
}

export type StatusLineInput = {
  readonly workflow: string
  readonly runIdShort: string
  readonly progress: string
  readonly modelRole: string | null
}

/**
 * Extracts a short run id (first 8 chars) from a full UUID.
 */
export function shortRunId(runId: string): string {
  return runId.slice(0, 8)
}

/**
 * Derives progress text from the run state.
 * - start_work: shows completed/total tasks
 * - ulw_loop: shows completed/total goals
 */
export function deriveProgress(run: {
  readonly workflow: string
  readonly payload: {
    readonly status: string
    readonly plan?: { readonly taskIds: readonly string[] }
    readonly goals?: readonly {
      readonly status: string
      readonly criteria: readonly { readonly status: string }[]
    }[]
  }
  readonly progressRevision: number
}): string {
  if (run.workflow === "start_work" && run.payload.plan !== undefined) {
    const taskIds = run.payload.plan.taskIds
    // progressRevision tracks accepted evidence count
    return `${run.progressRevision}/${taskIds.length}`
  }
  if (run.workflow === "ulw_loop" && run.payload.goals !== undefined) {
    const goals = run.payload.goals
    const complete = goals.filter((g) => g.status === "complete").length
    return `${complete}/${goals.length} goals`
  }
  return run.payload.status
}

/**
 * Publishes run state to the OMP status line. Fail-safe:
 * - No-op when `ctx.hasUI` is false (headless/RPC/print mode).
 * - Swallows and records a throw from `setStatus` or `setWorkingMessage`.
 * - Sanitizes all composed strings to a single line, capped length, no
 *   control or format characters.
 *
 * A UI failure never aborts a handler; untrusted text never reaches the UI
 * unsanitized.
 */
export class StatusLinePublisher {
  #lastStatus: string | null = null
  #lastWorkingMessage: string | null = null
  readonly #degradations: UIDegradation[] = []

  /**
   * Sets the status line for an active run with progress information.
   * No-op when `hasUI` is false. Swallows and records throws.
   */
  setRunStatus(ctx: ExtensionContext, input: StatusLineInput): void {
    if (!ctx.hasUI) return
    const line = sanitizeStatusText(composeStatusLine(input))
    this.#lastStatus = line
    try {
      ctx.ui.setStatus(STATUS_KEY, line)
    } catch (err) {
      this.#degradations.push({
        kind: "ui_degradation",
        method: "setStatus",
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      })
    }
  }

  /**
   * Sets the working message during tool dispatch.
   * No-op when `hasUI` is false. Swallows and records throws.
   */
  setWorking(ctx: ExtensionContext, message: string): void {
    if (!ctx.hasUI) return
    const sanitized = sanitizeStatusText(message)
    this.#lastWorkingMessage = sanitized
    try {
      ctx.ui.setWorkingMessage(sanitized)
    } catch (err) {
      this.#degradations.push({
        kind: "ui_degradation",
        method: "setWorkingMessage",
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      })
    }
  }

  /**
   * Clears both status and working message. Called on session_shutdown.
   * No-op when `hasUI` is false. Swallows and records throws.
   */
  clear(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return
    this.#lastStatus = null
    this.#lastWorkingMessage = null
    try {
      ctx.ui.setStatus(STATUS_KEY, undefined)
    } catch (err) {
      this.#degradations.push({
        kind: "ui_degradation",
        method: "setStatus",
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      })
    }
    try {
      ctx.ui.setWorkingMessage(undefined)
    } catch (err) {
      this.#degradations.push({
        kind: "ui_degradation",
        method: "setWorkingMessage",
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      })
    }
  }

  /** For diagnostics: the last status line set (or null if cleared). */
  get lastStatus(): string | null {
    return this.#lastStatus
  }

  /** For diagnostics: the last working message set (or null if cleared). */
  get lastWorkingMessage(): string | null {
    return this.#lastWorkingMessage
  }

  /** Recorded UI degradations (throws that were swallowed). */
  get degradations(): readonly UIDegradation[] {
    return this.#degradations
  }
}

/**
 * Derives the model role alias from the extension context.
 * Attempts to resolve the current model to a known role alias (@smol, @task, @slow).
 * Returns null when no model is set or it doesn't map to a known alias.
 */
export function deriveModelRole(
  context: Pick<ExtensionContext, "model" | "models">,
): string | null {
  if (context.model === undefined) return null
  // Try to determine which role alias the current model corresponds to
  for (const alias of ["@smol", "@task", "@slow"] as const) {
    const resolved = context.models.resolve(alias)
    if (
      resolved !== undefined &&
      context.models.family(resolved) === context.models.family(context.model)
    ) {
      return alias
    }
  }
  // If no role alias matches, return null (no vendor id exposed)
  return null
}
