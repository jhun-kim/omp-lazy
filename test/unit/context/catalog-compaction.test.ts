import { describe, expect, test } from "bun:test"
import {
  type CatalogEntry,
  compactCatalog,
  DESCRIPTION_CAP_BYTES,
  renderEntry,
} from "../../../src/context/catalog-compaction"

const ENTRY_A: CatalogEntry = {
  name: "alpha-skill",
  location: "skills/alpha-skill/SKILL.md",
  description: "Alpha skill for planning complex work",
}

const ENTRY_B: CatalogEntry = {
  name: "beta-skill",
  location: "skills/beta-skill/SKILL.md",
  description: "Beta skill for research tasks",
}

const ENTRY_C: CatalogEntry = {
  name: "gamma-skill",
  location: "skills/gamma-skill/SKILL.md",
  description: "Gamma skill for execution workflows",
}

const ENTRY_D: CatalogEntry = {
  name: "delta-skill",
  location: "skills/delta-skill/SKILL.md",
  description: "Delta skill for team coordination",
}

const ENTRY_E: CatalogEntry = {
  name: "epsilon-skill",
  location: "skills/epsilon-skill/SKILL.md",
  description: "Epsilon skill for loop-based automation",
}

const ALL_ENTRIES: CatalogEntry[] = [ENTRY_A, ENTRY_B, ENTRY_C, ENTRY_D, ENTRY_E]

function computeBudgetForN(n: number): number {
  // Sort entries by name (same as the module does)
  const sorted = [...ALL_ENTRIES].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  let bytes = 0
  for (let i = 0; i < n && i < sorted.length; i++) {
    const entry = sorted[i]
    if (entry === undefined) break
    const rendered = renderEntry(entry)
    const entryBytes = Buffer.byteLength(rendered, "utf-8")
    bytes += entryBytes + (i > 0 ? 1 : 0) // separator newline
  }
  return bytes
}

describe("catalog-compaction", () => {
  describe("whole-entry retention under budget", () => {
    test("with a budget that fits N of M entries, exactly N COMPLETE entries are emitted, each with its location", () => {
      // Budget that fits exactly 3 entries but not the 4th
      const budgetFor3 = computeBudgetForN(3)
      const budgetFor4 = computeBudgetForN(4)
      // Use a budget between 3-entry and 4-entry size
      const budget = budgetFor3 + Math.floor((budgetFor4 - budgetFor3) / 2)

      const result = compactCatalog(ALL_ENTRIES, budget)
      expect(result.entries.length).toBe(3)

      // Each emitted entry must have its location
      for (const entry of result.entries) {
        expect(entry.location.length).toBeGreaterThan(0)
        expect(entry.name.length).toBeGreaterThan(0)
      }
    })

    test("the retained set is IDENTICAL whether the input order is forward or reversed", () => {
      const budgetFor3 = computeBudgetForN(3)
      const budgetFor4 = computeBudgetForN(4)
      const budget = budgetFor3 + Math.floor((budgetFor4 - budgetFor3) / 2)

      const forward = compactCatalog(ALL_ENTRIES, budget)
      const reversed = compactCatalog([...ALL_ENTRIES].reverse(), budget)

      // Retained names must be the same set regardless of input order
      const forwardNames = forward.entries.map((e) => e.name).sort()
      const reversedNames = reversed.entries.map((e) => e.name).sort()
      expect(forwardNames).toEqual(reversedNames)

      // Output order must also be identical (explicit, deterministic)
      expect(forward.entries.map((e) => e.name)).toEqual(reversed.entries.map((e) => e.name))
    })

    test("no output line contains a truncated-entry marker", () => {
      const budget = computeBudgetForN(3)

      const result = compactCatalog(ALL_ENTRIES, budget)
      const output = result.rendered

      // Must not contain truncation markers like "...", "[truncated]", "…", "[...]"
      const truncationPatterns = ["[truncated]", "[...]", "…entry", "...entry", "-- truncated"]
      for (const pattern of truncationPatterns) {
        expect(output).not.toContain(pattern)
      }

      // Every line that is part of an entry must be complete
      const lines = output.split("\n")
      for (const line of lines) {
        expect(line).not.toMatch(/\[truncated\]|\[\.\.\.\]|…$/)
      }
    })

    test("an entry missing a location is rejected rather than emitted with a fabricated one", () => {
      const noLocation: CatalogEntry = {
        name: "broken-skill",
        location: "",
        description: "This has no location",
      }

      const result = compactCatalog([noLocation, ENTRY_A, ENTRY_B], 10_000)
      // The entry with an empty location must NOT appear in the output
      expect(result.entries.find((e) => e.name === "broken-skill")).toBeUndefined()
      // It must appear in rejected
      expect(result.rejected.find((r) => r.name === "broken-skill")).toBeDefined()
      // The other entries must still appear
      expect(result.entries.length).toBe(2)
    })

    test("a description longer than the cap is capped without breaking the entry", () => {
      const longDesc = "A".repeat(DESCRIPTION_CAP_BYTES + 200)
      const longEntry: CatalogEntry = {
        name: "verbose-skill",
        location: "skills/verbose-skill/SKILL.md",
        description: longDesc,
      }

      const result = compactCatalog([longEntry, ENTRY_A], 10_000)
      // The entry must still be present
      const found = result.entries.find((e) => e.name === "verbose-skill")
      expect(found).toBeDefined()
      // Its location must be intact
      expect(found?.location).toBe("skills/verbose-skill/SKILL.md")
      // The rendered description must be capped
      if (found) {
        const rendered = renderEntry(found)
        // The full description should not appear in the output
        expect(rendered).not.toContain(longDesc)
      }
    })
  })

  describe("generous budget retains all entries", () => {
    test("all entries are emitted when budget is large enough", () => {
      const result = compactCatalog(ALL_ENTRIES, 100_000)
      expect(result.entries.length).toBe(ALL_ENTRIES.length)
      expect(result.dropped.length).toBe(0)
      for (const entry of result.entries) {
        expect(entry.location.length).toBeGreaterThan(0)
      }
    })
  })

  describe("dropped entries are reported", () => {
    test("dropped entries are named in the result", () => {
      // Budget that fits only 2 entries
      const budget = computeBudgetForN(2)

      const result = compactCatalog(ALL_ENTRIES, budget)
      expect(result.entries.length).toBe(2)
      expect(result.dropped.length).toBe(3)
      // Every dropped entry is named
      for (const d of result.dropped) {
        expect(d.length).toBeGreaterThan(0)
      }
    })
  })

  describe("entry rendering", () => {
    test("renderEntry produces name, location, and description", () => {
      const rendered = renderEntry(ENTRY_A)
      expect(rendered).toContain("alpha-skill")
      expect(rendered).toContain("skills/alpha-skill/SKILL.md")
      expect(rendered).toContain("Alpha skill")
    })

    test("renderEntry with no description still includes name and location", () => {
      const noDesc: CatalogEntry = {
        name: "minimal-skill",
        location: "skills/minimal-skill/SKILL.md",
        description: "",
      }
      const rendered = renderEntry(noDesc)
      expect(rendered).toContain("minimal-skill")
      expect(rendered).toContain("skills/minimal-skill/SKILL.md")
    })
  })

  describe("adversarial: malformed input", () => {
    test("entry with empty name is rejected", () => {
      const emptyName: CatalogEntry = {
        name: "",
        location: "skills/x/SKILL.md",
        description: "Has no name",
      }
      const result = compactCatalog([emptyName, ENTRY_A], 10_000)
      expect(result.entries.find((e) => e.name === "")).toBeUndefined()
      expect(result.rejected.find((r) => r.name === "")).toBeDefined()
    })

    test("entry with no location is rejected", () => {
      const noLoc: CatalogEntry = {
        name: "orphan",
        location: "",
        description: "Missing location",
      }
      const result = compactCatalog([noLoc, ENTRY_A], 10_000)
      expect(result.entries.find((e) => e.name === "orphan")).toBeUndefined()
      expect(result.rejected.find((r) => r.name === "orphan")).toBeDefined()
    })

    test("description containing CRLF, ANSI escapes, and NUL is sanitized", () => {
      const dirty: CatalogEntry = {
        name: "dirty-skill",
        location: "skills/dirty-skill/SKILL.md",
        description: "Line1\r\nLine2\x1b[31mRed\x1b[0m\x00Null",
      }
      const result = compactCatalog([dirty], 10_000)
      expect(result.entries.length).toBe(1)
      const first = result.entries[0]
      expect(first).toBeDefined()
      if (first) {
        const rendered = renderEntry(first)
        // Must not contain raw CRLF, ANSI escapes, or NUL in output
        expect(rendered).not.toContain("\r\n")
        expect(rendered).not.toContain("\x1b")
        expect(rendered).not.toContain("\x00")
      }
    })

    test("a single entry larger than the whole budget is dropped, not partially emitted", () => {
      const huge: CatalogEntry = {
        name: "huge-skill",
        location: "skills/huge-skill/SKILL.md",
        description: "X".repeat(5000),
      }
      // Budget smaller than this one entry
      const entrySize = Buffer.byteLength(renderEntry(huge), "utf-8")
      const tinyBudget = Math.floor(entrySize / 2)

      const result = compactCatalog([huge, ENTRY_A], tinyBudget)
      // The huge entry must not appear (partially or fully)
      expect(result.entries.find((e) => e.name === "huge-skill")).toBeUndefined()
      expect(result.dropped).toContain("huge-skill")
      // If ENTRY_A fits, it should be there
      const entryASize = Buffer.byteLength(renderEntry(ENTRY_A), "utf-8")
      if (entryASize <= tinyBudget) {
        expect(result.entries.find((e) => e.name === "alpha-skill")).toBeDefined()
      }
    })
  })

  describe("adversarial: misleading_success_output", () => {
    test("prove retention by parsing output back into entries and asserting completeness", () => {
      const budget = computeBudgetForN(3)

      const result = compactCatalog(ALL_ENTRIES, budget)
      // Parse the rendered output back and verify each entry is complete
      const outputLines = result.rendered.split("\n")
      const parsedEntries: Array<{ name: string; location: string }> = []

      for (const line of outputLines) {
        // Our format: "- name: <name> | location: <location> | <description>"
        const match = /^- name: (.+?) \| location: (.+?)(?:\s*\|.*)?$/.exec(line)
        if (match?.[1] && match[2]) {
          parsedEntries.push({ name: match[1], location: match[2].trim() })
        }
      }

      // The number of parsed entries must equal result.entries.length
      expect(parsedEntries.length).toBe(result.entries.length)

      // Each parsed entry must have both a non-empty name and location
      for (const parsed of parsedEntries) {
        expect(parsed.name.length).toBeGreaterThan(0)
        expect(parsed.location.length).toBeGreaterThan(0)
        // Location must not be a fabrication - must match an input entry
        const original = ALL_ENTRIES.find((e) => e.name === parsed.name)
        if (original === undefined) {
          throw new Error(`parsed entry "${parsed.name}" has no matching input in ALL_ENTRIES`)
        }
        expect(parsed.location).toBe(original.location)
      }
    })
  })
})
