/**
 * Truncation-safe directive/skill catalog compaction.
 *
 * Designs out the observed defect where an oversized prompt kept only the TAIL
 * of a skills catalog, losing a skill's location and instructions. This module
 * guarantees:
 * - Each catalog entry is rendered as name + location + capped description.
 * - Entries are emitted COMPLETE or not at all (whole-entry retention).
 * - Retention order is EXPLICIT and never dependent on input file order.
 * - Every emitted entry keeps its location.
 * - A location is never fabricated.
 * - A partial entry or a truncated-entry marker is never emitted inside an entry.
 */

/** Maximum bytes for a single entry's description (UTF-8). */
export const DESCRIPTION_CAP_BYTES = 300

/**
 * A catalog entry representing a skill or directive.
 */
export type CatalogEntry = {
  readonly name: string
  readonly location: string
  readonly description: string
}

/**
 * A rejected entry with the reason it was dropped.
 */
export type RejectedEntry = {
  readonly name: string
  readonly reason: string
}

/**
 * Result of compacting a catalog under a byte budget.
 */
export type CompactionResult = {
  /** Retained entries, in deterministic order. */
  readonly entries: readonly CatalogEntry[]
  /** Names of entries dropped to fit the budget. */
  readonly dropped: readonly string[]
  /** Entries rejected due to validation failure (empty name, missing location). */
  readonly rejected: readonly RejectedEntry[]
  /** The fully rendered catalog text. */
  readonly rendered: string
  /** Total UTF-8 bytes of the rendered output. */
  readonly totalBytes: number
}

/**
 * Sanitizes a description string: removes CRLF, ANSI escape sequences, and NUL bytes,
 * then caps at DESCRIPTION_CAP_BYTES UTF-8 bytes.
 */
function sanitizeDescription(description: string): string {
  // Remove NUL bytes
  let clean = description.replaceAll("\x00", "")
  // Remove ANSI escape sequences (ESC [ ... letter)
  const ESC = String.fromCharCode(0x1b)
  clean = clean.split(ESC).reduce((acc, part, i) => {
    if (i === 0) return part
    // Strip the CSI sequence: [ followed by digits/semicolons then a letter
    const stripped = part.replace(/^\[[0-9;]*[A-Za-z]/, "")
    return acc + stripped
  }, "")
  // Replace CRLF and standalone CR with a space
  clean = clean.replaceAll("\r\n", " ")
  clean = clean.replaceAll("\r", " ")
  // Replace LF with a space (keep output single-line per entry)
  clean = clean.replaceAll("\n", " ")
  // Collapse multiple spaces
  clean = clean.replace(/ {2,}/g, " ").trim()

  // Cap at DESCRIPTION_CAP_BYTES (UTF-8 byte length)
  const encoder = new TextEncoder()
  const encoded = encoder.encode(clean)
  if (encoded.byteLength <= DESCRIPTION_CAP_BYTES) return clean

  // Truncate at byte boundary without breaking a multi-byte character
  const decoder = new TextDecoder("utf-8", { fatal: false })
  const truncated = decoder.decode(encoded.slice(0, DESCRIPTION_CAP_BYTES))
  // Remove possible broken trailing character (replacement character)
  return truncated.replace(/\uFFFD$/, "")
}

/**
 * Validates an entry. Returns a rejection reason or null if valid.
 */
function validateEntry(entry: CatalogEntry): string | null {
  if (!entry.name || entry.name.trim().length === 0) {
    return "empty_name"
  }
  if (!entry.location || entry.location.trim().length === 0) {
    return "missing_location"
  }
  return null
}

/**
 * Renders a single catalog entry into its deterministic text form.
 * Format: `- name: <name> | location: <location> | <description>`
 *
 * The description is sanitized and capped before rendering.
 */
export function renderEntry(entry: CatalogEntry): string {
  const desc = sanitizeDescription(entry.description)
  if (desc.length > 0) {
    return `- name: ${entry.name} | location: ${entry.location} | ${desc}`
  }
  return `- name: ${entry.name} | location: ${entry.location}`
}

/**
 * Compacts a catalog of entries to fit within a UTF-8 byte budget.
 *
 * The algorithm:
 * 1. Validates each entry; rejects entries with empty names or missing locations.
 * 2. Sorts valid entries by name (lexicographic, case-sensitive) for deterministic,
 *    input-order-independent retention.
 * 3. Renders each entry and greedily retains entries in sorted order until the budget
 *    is exhausted.
 * 4. Entries that do not fit are reported in `dropped`.
 *
 * This guarantees:
 * - Retention order is explicit (alphabetical by name), never input-file-order-dependent.
 * - An entry is emitted complete or not at all.
 * - Every emitted entry keeps its location (never fabricated, never dropped).
 */
export function compactCatalog(
  entries: readonly CatalogEntry[],
  budgetBytes: number,
): CompactionResult {
  const rejected: RejectedEntry[] = []
  const valid: CatalogEntry[] = []

  // Phase 1: validate
  for (const entry of entries) {
    const reason = validateEntry(entry)
    if (reason !== null) {
      rejected.push({ name: entry.name, reason })
    } else {
      // Apply description sanitization to produce the retained form
      valid.push({
        name: entry.name,
        location: entry.location,
        description: sanitizeDescription(entry.description),
      })
    }
  }

  // Phase 2: sort by name for deterministic, input-order-independent retention
  valid.sort((a, b) => {
    if (a.name < b.name) return -1
    return a.name > b.name ? 1 : 0
  })

  // Phase 3: greedy retention under budget
  const retained: CatalogEntry[] = []
  const dropped: string[] = []
  let usedBytes = 0

  for (const entry of valid) {
    const rendered = renderEntry(entry)
    const entryBytes = Buffer.byteLength(rendered, "utf-8")
    // Account for newline separator between entries
    const separatorBytes = retained.length > 0 ? 1 : 0
    const totalNeeded = entryBytes + separatorBytes

    if (usedBytes + totalNeeded <= budgetBytes) {
      retained.push(entry)
      usedBytes += totalNeeded
    } else {
      dropped.push(entry.name)
    }
  }

  // Phase 4: render final output
  const renderedLines = retained.map(renderEntry)
  const rendered = renderedLines.join("\n")
  const totalBytes = Buffer.byteLength(rendered, "utf-8")

  return {
    entries: retained,
    dropped,
    rejected,
    rendered,
    totalBytes,
  }
}
