/**
 * Maximum character count for a status line or working message.
 * Mirrors the `LABEL_MAX = 80` precedent in the host's `oneLineLabel`
 * (`node_modules/@oh-my-pi/pi-coding-agent/src/task/types.ts:107`),
 * but uses a slightly higher cap because the status line encodes workflow,
 * run id, progress AND model role.
 */
export const STATUS_TEXT_MAX = 120

/**
 * Sanitizes untrusted text for safe single-line display on the OMP status line.
 *
 * Mirrors the `oneLineLabel` precedent in the host:
 * - Collapses every run of control characters (Cc), format characters (Cf), and
 *   whitespace to a single space.
 * - Trims leading and trailing spaces.
 * - Caps at `max` characters (code-point count, not UTF-16 code units, so astral
 *   characters are never split into lone surrogates).
 * - Appends an ellipsis when truncated.
 *
 * The result is always a single line with no control or format characters —
 * so untrusted text (plan titles, goal text) cannot inject terminal escapes,
 * ANSI sequences, extra lines, or zero-width separators.
 */
export function sanitizeStatusText(text: string, max = STATUS_TEXT_MAX): string {
  // Collapse control (Cc), format (Cf), and whitespace into a single space
  const oneLine = text.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim()
  const cap = Math.max(1, max)
  // Count and cut by code point so truncation never splits an astral character
  const chars = [...oneLine]
  return chars.length > cap ? `${chars.slice(0, cap - 1).join("")}…` : oneLine
}

/**
 * A recorded UI degradation that did not abort the handler.
 */
export type UIDegradation = {
  readonly kind: "ui_degradation"
  readonly method: "setStatus" | "setWorkingMessage"
  readonly error: string
  readonly timestamp: number
}
