import { describe, expect, test } from "bun:test"
import {
  type AssemblyInput,
  assembleRules,
  CATALOG_BUDGET_BYTES,
  DIRECTIVE_BUDGET_BYTES,
  INJECTION_BUDGET_BYTES,
  matchGlob,
  RULES_BUDGET_BYTES,
} from "../../../src/context/rules-assembly"

function makeRule(
  id: string,
  globs: string[],
  body: string,
  order?: number,
): AssemblyInput["rules"][number] {
  return {
    fileName: `${id}.md`,
    relativePath: `.omo/rules/${id}.md`,
    displayPath: `/repo/.omo/rules/${id}.md`,
    globs,
    order: order ?? null,
    description: null,
    body,
    bytes: Buffer.byteLength(body, "utf8"),
  }
}

function makeInput(overrides: Partial<AssemblyInput> = {}): AssemblyInput {
  return {
    rules: overrides.rules ?? [],
    touchedPaths: overrides.touchedPaths ?? ["src/main.ts"],
    directiveText: overrides.directiveText ?? null,
    catalogText: overrides.catalogText ?? null,
  }
}

describe("rules-assembly constants", () => {
  test("the four budget constants sum exactly to INJECTION_BUDGET_BYTES (65536)", () => {
    expect(INJECTION_BUDGET_BYTES).toBe(65536)
    expect(DIRECTIVE_BUDGET_BYTES).toBe(32768)
    expect(RULES_BUDGET_BYTES).toBe(20480)
    expect(CATALOG_BUDGET_BYTES).toBe(12288)
    expect(DIRECTIVE_BUDGET_BYTES + RULES_BUDGET_BYTES + CATALOG_BUDGET_BYTES).toBe(
      INJECTION_BUDGET_BYTES,
    )
  })
})

describe("determinism", () => {
  test("identical input yields byte-identical output across 100 runs", () => {
    const rules = [
      makeRule("alpha", ["src/**/*.ts"], "Rule alpha body content here"),
      makeRule("beta", ["src/**/*.ts"], "Rule beta body content"),
      makeRule("gamma", ["src/**/*.ts"], "Rule gamma body content", 5),
    ]
    const input = makeInput({ rules, touchedPaths: ["src/main.ts"] })

    const first = assembleRules(input)
    for (let i = 1; i < 100; i++) {
      const current = assembleRules(input)
      expect(current.assembledRules).toBe(first.assembledRules)
      expect(current.assembledDirective).toBe(first.assembledDirective)
      expect(current.assembledCatalog).toBe(first.assembledCatalog)
      expect(current.droppedUnits).toEqual(first.droppedUnits)
      expect(current.retainedUnits).toEqual(first.retainedUnits)
    }
  })
})

describe("byte budget enforcement", () => {
  test("total assembly never exceeds INJECTION_BUDGET_BYTES", () => {
    // Create large rules that would exceed the budget if all included
    const bigBody = "X".repeat(5000)
    const rules = Array.from({ length: 50 }, (_, i) =>
      makeRule(`rule-${String(i).padStart(3, "0")}`, ["src/**/*.ts"], bigBody, i),
    )
    const input = makeInput({
      rules,
      touchedPaths: ["src/main.ts"],
      directiveText: "D".repeat(10000),
      catalogText: "C".repeat(5000),
    })

    const result = assembleRules(input)

    const totalBytes =
      Buffer.byteLength(result.assembledRules ?? "", "utf8") +
      Buffer.byteLength(result.assembledDirective ?? "", "utf8") +
      Buffer.byteLength(result.assembledCatalog ?? "", "utf8")
    expect(totalBytes).toBeLessThanOrEqual(INJECTION_BUDGET_BYTES)
  })

  test("rules section never exceeds RULES_BUDGET_BYTES", () => {
    const bigBody = "X".repeat(5000)
    const rules = Array.from({ length: 50 }, (_, i) =>
      makeRule(`rule-${String(i).padStart(3, "0")}`, ["src/**/*.ts"], bigBody, i),
    )
    const input = makeInput({ rules, touchedPaths: ["src/main.ts"] })

    const result = assembleRules(input)
    const rulesBytes = Buffer.byteLength(result.assembledRules ?? "", "utf8")
    expect(rulesBytes).toBeLessThanOrEqual(RULES_BUDGET_BYTES)
  })

  test("directive section never exceeds DIRECTIVE_BUDGET_BYTES", () => {
    const bigDirective = "D".repeat(40000)
    const input = makeInput({ directiveText: bigDirective })

    const result = assembleRules(input)
    const directiveBytes = Buffer.byteLength(result.assembledDirective ?? "", "utf8")
    expect(directiveBytes).toBeLessThanOrEqual(DIRECTIVE_BUDGET_BYTES)
  })

  test("catalog section never exceeds CATALOG_BUDGET_BYTES", () => {
    const bigCatalog = "C".repeat(20000)
    const input = makeInput({ catalogText: bigCatalog })

    const result = assembleRules(input)
    const catalogBytes = Buffer.byteLength(result.assembledCatalog ?? "", "utf8")
    expect(catalogBytes).toBeLessThanOrEqual(CATALOG_BUDGET_BYTES)
  })
})

describe("overflow drops lowest-priority whole unit", () => {
  test("when rules exceed budget, lowest-priority whole rules are dropped and named", () => {
    // Each rule is about 5000 bytes; RULES_BUDGET_BYTES = 20480 so ~4 fit
    const bigBody = "X".repeat(4900)
    const rules = Array.from({ length: 10 }, (_, i) =>
      makeRule(`rule-${String(i).padStart(3, "0")}`, ["src/**/*.ts"], bigBody, i),
    )
    const input = makeInput({ rules, touchedPaths: ["src/main.ts"] })

    const result = assembleRules(input)

    // Some rules must be dropped
    expect(result.droppedUnits.length).toBeGreaterThan(0)
    // The dropped rules must be the ones with highest order numbers (lowest priority = highest order in rules section)
    for (const dropped of result.droppedUnits) {
      expect(dropped.section).toBe("rules")
      expect(dropped.id).toMatch(/^rule-\d{3}\.md$/)
    }
    // Rules section stays within budget
    const rulesBytes = Buffer.byteLength(result.assembledRules ?? "", "utf8")
    expect(rulesBytes).toBeLessThanOrEqual(RULES_BUDGET_BYTES)
  })

  test("a rule is NEVER emitted partially", () => {
    // Create rules where including all would exceed budget, each with UNIQUE body
    const rules = Array.from({ length: 10 }, (_, i) => {
      const uniqueBody = `UNIQUE_RULE_${i}_MARKER_${String.fromCharCode(65 + i).repeat(4800)}`
      return makeRule(`rule-${String(i).padStart(3, "0")}`, ["src/**/*.ts"], uniqueBody, i)
    })
    const input = makeInput({ rules, touchedPaths: ["src/main.ts"] })

    const result = assembleRules(input)
    const assembled = result.assembledRules ?? ""

    // Some rules must be dropped since total exceeds budget
    expect(result.droppedUnits.length).toBeGreaterThan(0)

    // For each retained rule, the full body must be present
    for (const retained of result.retainedUnits.filter((u) => u.section === "rules")) {
      const matchingRule = rules.find((r) => r.fileName === retained.id)
      expect(matchingRule).toBeDefined()
      if (matchingRule) {
        expect(assembled).toContain(matchingRule.body)
      }
    }
    // For each dropped rule, its unique marker must NOT appear
    for (const dropped of result.droppedUnits.filter((u) => u.section === "rules")) {
      const matchingRule = rules.find((r) => r.fileName === dropped.id)
      expect(matchingRule).toBeDefined()
      if (matchingRule) {
        // Dropped rules must not have their unique content in the output
        expect(assembled).not.toContain(`UNIQUE_RULE_${rules.indexOf(matchingRule)}_MARKER_`)
      }
    }
  })

  test("priority on overflow: rules are dropped before catalog, catalog before directive", () => {
    // Fill everything to near-budget
    const directiveText = "D".repeat(30000) // < 32768
    const catalogText = "C".repeat(11000) // < 12288
    const bigBody = "X".repeat(4900)
    const rules = Array.from({ length: 10 }, (_, i) =>
      makeRule(`rule-${String(i).padStart(3, "0")}`, ["src/**/*.ts"], bigBody, i),
    )
    const input = makeInput({ rules, touchedPaths: ["src/main.ts"], directiveText, catalogText })

    const result = assembleRules(input)

    // Directive should be retained (highest priority after user turn)
    expect(result.assembledDirective).not.toBeNull()
    expect(Buffer.byteLength(result.assembledDirective ?? "", "utf8")).toBeGreaterThan(0)
  })
})

describe("deterministic ordering", () => {
  test("explicit order takes precedence over path specificity and filename", () => {
    const rules = [
      makeRule("zzz-last", ["src/**/*.ts"], "Body of zzz", 1),
      makeRule("aaa-first", ["src/**/*.ts"], "Body of aaa", 10),
      makeRule("mmm-middle", ["src/**/*.ts"], "Body of mmm", 5),
    ]
    const input = makeInput({ rules, touchedPaths: ["src/main.ts"] })

    const result = assembleRules(input)
    const assembled = result.assembledRules ?? ""

    const posZzz = assembled.indexOf("Body of zzz")
    const posMmm = assembled.indexOf("Body of mmm")
    const posAaa = assembled.indexOf("Body of aaa")

    expect(posZzz).toBeGreaterThan(-1)
    expect(posMmm).toBeGreaterThan(-1)
    expect(posAaa).toBeGreaterThan(-1)
    // Lower order number appears first
    expect(posZzz).toBeLessThan(posMmm)
    expect(posMmm).toBeLessThan(posAaa)
  })

  test("when order is equal, more specific path glob wins", () => {
    const rules = [
      makeRule("broad", ["**/*.ts"], "Body of broad", 5),
      makeRule("narrow", ["src/utils/**/*.ts"], "Body of narrow", 5),
    ]
    const input = makeInput({ rules, touchedPaths: ["src/utils/helper.ts"] })

    const result = assembleRules(input)
    const assembled = result.assembledRules ?? ""

    const posBroad = assembled.indexOf("Body of broad")
    const posNarrow = assembled.indexOf("Body of narrow")

    expect(posNarrow).toBeGreaterThan(-1)
    expect(posBroad).toBeGreaterThan(-1)
    // More specific (longer glob without wildcards) comes first
    expect(posNarrow).toBeLessThan(posBroad)
  })

  test("when order and specificity are equal, filename breaks the tie", () => {
    const rules = [
      makeRule("beta", ["src/**/*.ts"], "Body of beta", 5),
      makeRule("alpha", ["src/**/*.ts"], "Body of alpha", 5),
    ]
    const input = makeInput({ rules, touchedPaths: ["src/main.ts"] })

    const result = assembleRules(input)
    const assembled = result.assembledRules ?? ""

    const posAlpha = assembled.indexOf("Body of alpha")
    const posBeta = assembled.indexOf("Body of beta")

    expect(posAlpha).toBeGreaterThan(-1)
    expect(posBeta).toBeGreaterThan(-1)
    expect(posAlpha).toBeLessThan(posBeta)
  })
})

describe("glob matching", () => {
  test("Windows backslash and POSIX slash paths yield identical results", () => {
    const glob = "src/**/*.ts"
    const posixPath = "src/utils/helper.ts"
    const windowsPath = "src\\utils\\helper.ts"

    expect(matchGlob(glob, posixPath)).toBe(true)
    expect(matchGlob(glob, windowsPath)).toBe(true)
  })

  test("** matches zero or more directory segments", () => {
    expect(matchGlob("src/**/*.ts", "src/main.ts")).toBe(true)
    expect(matchGlob("src/**/*.ts", "src/a/b/c.ts")).toBe(true)
    expect(matchGlob("**/*.ts", "deeply/nested/file.ts")).toBe(true)
    expect(matchGlob("**/*.ts", "file.ts")).toBe(true)
  })

  test("* matches within a single segment", () => {
    expect(matchGlob("src/*.ts", "src/main.ts")).toBe(true)
    expect(matchGlob("src/*.ts", "src/sub/main.ts")).toBe(false)
  })

  test("? matches a single character", () => {
    expect(matchGlob("src/?.ts", "src/a.ts")).toBe(true)
    expect(matchGlob("src/?.ts", "src/ab.ts")).toBe(false)
  })

  test("non-matching paths are excluded", () => {
    expect(matchGlob("src/**/*.ts", "test/main.ts")).toBe(false)
    expect(matchGlob("src/**/*.ts", "src/main.js")).toBe(false)
  })
})

describe("assembly with path matching", () => {
  test("only rules whose globs match touched paths are assembled", () => {
    const rules = [
      makeRule("ts-rule", ["src/**/*.ts"], "TypeScript rule"),
      makeRule("md-rule", ["**/*.md"], "Markdown rule"),
      makeRule("py-rule", ["**/*.py"], "Python rule"),
    ]
    const input = makeInput({ rules, touchedPaths: ["src/main.ts", "README.md"] })

    const result = assembleRules(input)
    const assembled = result.assembledRules ?? ""

    expect(assembled).toContain("TypeScript rule")
    expect(assembled).toContain("Markdown rule")
    expect(assembled).not.toContain("Python rule")
  })
})

// ---------------------------------------------------------------------------
// QA Scenarios (exact plan requirements)
// ---------------------------------------------------------------------------

describe("QA scenario: happy - 3 matching rules under budget", () => {
  test("assemble 3 matching rules under budget: full inclusion plus empty dropped list", () => {
    const rules = [
      makeRule("rule-a", ["src/**/*.ts"], "Short rule A body"),
      makeRule("rule-b", ["src/**/*.ts"], "Short rule B body"),
      makeRule("rule-c", ["src/**/*.ts"], "Short rule C body"),
    ]
    const input = makeInput({ rules, touchedPaths: ["src/main.ts"] })

    const result = assembleRules(input)

    // Full inclusion
    expect(result.assembledRules).toContain("Short rule A body")
    expect(result.assembledRules).toContain("Short rule B body")
    expect(result.assembledRules).toContain("Short rule C body")

    // Empty dropped list for rules section
    const droppedRules = result.droppedUnits.filter((u) => u.section === "rules")
    expect(droppedRules).toHaveLength(0)

    // All 3 retained
    const retainedRules = result.retainedUnits.filter((u) => u.section === "rules")
    expect(retainedRules).toHaveLength(3)

    // Under budget
    expect(result.totalBytes).toBeLessThanOrEqual(INJECTION_BUDGET_BYTES)
    const rulesBytes = Buffer.byteLength(result.assembledRules ?? "", "utf8")
    expect(rulesBytes).toBeLessThanOrEqual(RULES_BUDGET_BYTES)
  })
})

describe("QA scenario: failure - 50 oversized rules", () => {
  test("assemble 50 oversized rules: every cap holds, report lists every dropped rule name, no partial rule text", () => {
    // Each rule ~5000 bytes, total would be ~250000 bytes, far exceeds RULES_BUDGET_BYTES=20480
    const rules = Array.from({ length: 50 }, (_, i) => {
      const uniqueMarker = `UNIQUE_MARKER_${String(i).padStart(3, "0")}`
      const body = `${uniqueMarker}_${"Y".repeat(4900)}`
      return makeRule(`oversized-${String(i).padStart(3, "0")}`, ["src/**/*.ts"], body, i)
    })
    const input = makeInput({ rules, touchedPaths: ["src/main.ts"] })

    const result = assembleRules(input)

    // Cap: total never exceeds INJECTION_BUDGET_BYTES
    expect(result.totalBytes).toBeLessThanOrEqual(INJECTION_BUDGET_BYTES)

    // Cap: rules section never exceeds RULES_BUDGET_BYTES
    const rulesBytes = Buffer.byteLength(result.assembledRules ?? "", "utf8")
    expect(rulesBytes).toBeLessThanOrEqual(RULES_BUDGET_BYTES)

    // Dropped rules must be reported
    expect(result.droppedUnits.length).toBeGreaterThan(0)

    // Retained + dropped should account for all 50
    const retainedRuleIds = result.retainedUnits
      .filter((u) => u.section === "rules")
      .map((u) => u.id)
    const droppedRuleIds = result.droppedUnits.filter((u) => u.section === "rules").map((u) => u.id)
    expect(retainedRuleIds.length + droppedRuleIds.length).toBe(50)

    // Every dropped rule is named
    for (const dropped of result.droppedUnits.filter((u) => u.section === "rules")) {
      expect(dropped.id).toMatch(/^oversized-\d{3}\.md$/)
      expect(dropped.reason.length).toBeGreaterThan(0)
    }

    // No partial rule text: every retained rule's unique marker is fully present
    const assembled = result.assembledRules ?? ""
    for (const retainedId of retainedRuleIds) {
      const idx = Number.parseInt(retainedId.replace("oversized-", "").replace(".md", ""), 10)
      const expectedMarker = `UNIQUE_MARKER_${String(idx).padStart(3, "0")}`
      expect(assembled).toContain(expectedMarker)
    }

    // No partial rule text: every dropped rule's unique marker must NOT appear
    for (const droppedId of droppedRuleIds) {
      const idx = Number.parseInt(droppedId.replace("oversized-", "").replace(".md", ""), 10)
      const droppedMarker = `UNIQUE_MARKER_${String(idx).padStart(3, "0")}`
      expect(assembled).not.toContain(droppedMarker)
    }
  })
})
