import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type InjectionReceiptInput,
  InjectionReceiptSchema,
  writeInjectionReceipt,
} from "../../src/context/injection-receipt-writer"
import {
  CATALOG_BUDGET_BYTES,
  INJECTION_BUDGET_BYTES,
  RULES_BUDGET_BYTES,
} from "../../src/context/rules-assembly"
import type { CanonicalRoot } from "../../src/state/domain"
import { isValidLifecycleId } from "../../src/state/paths"

/**
 * Contract tests for todo 9: persist a per-session context-injection receipt
 * as a schemaVersion 2 record at `directive-activations/<sessionId>.json`.
 */

function tempRoot(): string {
  return join(tmpdir(), `omp-lazy-test-receipt-${crypto.randomUUID()}`)
}

function canonicalRoot(path: string): CanonicalRoot {
  const normalized = path.replaceAll("\\", "/")
  return {
    canonicalPath: process.platform === "win32" ? normalized.toLowerCase() : normalized,
    displayPath: path,
  }
}

function makeInput(overrides?: Partial<InjectionReceiptInput>): InjectionReceiptInput {
  return {
    sessionId: "test-session-abc123",
    matched: [
      { fileName: "no-console.md", bytes: 512 },
      { fileName: "lint-rules.md", bytes: 1024 },
    ],
    dropped: [
      {
        id: "oversized-rule.md",
        section: "rules",
        reason: "rules budget exceeded (would be 21000 > 20480)",
      },
    ],
    totals: {
      rulesBytes: 1536,
      catalogBytes: 2048,
      totalBytes: 3584,
    },
    budget: {
      injectionBudgetBytes: INJECTION_BUDGET_BYTES,
      rulesBudgetBytes: RULES_BUDGET_BYTES,
      catalogBudgetBytes: CATALOG_BUDGET_BYTES,
    },
    ...overrides,
  }
}

const tempRoots: string[] = []

afterEach(async () => {
  for (const root of tempRoots) {
    try {
      // Restore permissions on Windows/POSIX before cleanup
      if (process.platform !== "win32") {
        try {
          await chmod(join(root, ".omo", "omp-lazy"), 0o755)
        } catch {}
      }
      await rm(root, { recursive: true, force: true })
    } catch {}
  }
  tempRoots.length = 0
})

describe("injection receipt persistence (todo 9)", () => {
  describe("happy path: receipt is written atomically as v2", () => {
    test("Given valid injection data When writeInjectionReceipt is called Then a schemaVersion 2 file is written at directive-activations/<sessionId>.json", async () => {
      const root = tempRoot()
      tempRoots.push(root)
      await mkdir(join(root, ".omo", "omp-lazy"), { recursive: true })
      const canonical = canonicalRoot(root)
      const input = makeInput()

      const result = await writeInjectionReceipt(canonical, input)

      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("unreachable")
      expect(result.status).toBe("written")

      // Read back the file and validate
      const filePath = join(
        root,
        ".omo",
        "omp-lazy",
        "directive-activations",
        "test-session-abc123.json",
      )
      const bytes = await readFile(filePath, "utf8")
      const parsed = JSON.parse(bytes)
      expect(parsed.schemaVersion).toBe(2)
      expect(parsed.sessionId).toBe("test-session-abc123")
      expect(parsed.matched).toEqual([
        { fileName: "no-console.md", bytes: 512 },
        { fileName: "lint-rules.md", bytes: 1024 },
      ])
      expect(parsed.dropped).toEqual([
        {
          id: "oversized-rule.md",
          section: "rules",
          reason: "rules budget exceeded (would be 21000 > 20480)",
        },
      ])
      expect(parsed.totals).toEqual({
        rulesBytes: 1536,
        catalogBytes: 2048,
        totalBytes: 3584,
      })
      expect(parsed.budget).toEqual({
        injectionBudgetBytes: INJECTION_BUDGET_BYTES,
        rulesBudgetBytes: RULES_BUDGET_BYTES,
        catalogBudgetBytes: CATALOG_BUDGET_BYTES,
      })
    })

    test("Given a valid receipt When schema-validated Then it passes InjectionReceiptSchema", async () => {
      const root = tempRoot()
      tempRoots.push(root)
      await mkdir(join(root, ".omo", "omp-lazy"), { recursive: true })
      const canonical = canonicalRoot(root)
      const input = makeInput()

      await writeInjectionReceipt(canonical, input)

      const filePath = join(
        root,
        ".omo",
        "omp-lazy",
        "directive-activations",
        "test-session-abc123.json",
      )
      const bytes = await readFile(filePath, "utf8")
      const parsed = JSON.parse(bytes)
      const validation = InjectionReceiptSchema.safeParse(parsed)
      expect(validation.success).toBe(true)
    })

    test("Given two sequential writes When both complete Then the second replaces the first (atomic overwrite)", async () => {
      const root = tempRoot()
      tempRoots.push(root)
      await mkdir(join(root, ".omo", "omp-lazy"), { recursive: true })
      const canonical = canonicalRoot(root)

      const input1 = makeInput({ matched: [{ fileName: "first.md", bytes: 100 }] })
      const input2 = makeInput({ matched: [{ fileName: "second.md", bytes: 200 }] })

      await writeInjectionReceipt(canonical, input1)
      await writeInjectionReceipt(canonical, input2)

      const filePath = join(
        root,
        ".omo",
        "omp-lazy",
        "directive-activations",
        "test-session-abc123.json",
      )
      const bytes = await readFile(filePath, "utf8")
      const parsed = JSON.parse(bytes)
      // Second write must have replaced the first
      expect(parsed.matched).toEqual([{ fileName: "second.md", bytes: 200 }])
    })
  })

  describe("degradation: write failure does not block context injection", () => {
    test("Given an unwritable state root When writeInjectionReceipt is called Then it returns degraded without throwing", async () => {
      const root = tempRoot()
      tempRoots.push(root)
      await mkdir(join(root, ".omo", "omp-lazy"), { recursive: true })
      const canonical = canonicalRoot(root)
      const input = makeInput()

      // Make the directory read-only (POSIX) or test with non-existent parent on Windows
      if (process.platform === "win32") {
        // On Windows we simulate by using a path that's invalid for writing
        const badRoot = join(root, "nonexistent-deep-path", "that", "cannot", "be", "created")
        const badCanonical = canonicalRoot(badRoot)
        const result = await writeInjectionReceipt(badCanonical, input)
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error("unreachable")
        expect(result.code).toBe("degraded")
        expect(result.reason.length).toBeGreaterThan(0)
      } else {
        // On POSIX, make the target directory read-only
        const dirActivations = join(root, ".omo", "omp-lazy", "directive-activations")
        await mkdir(dirActivations, { recursive: true })
        await chmod(dirActivations, 0o444)
        const result = await writeInjectionReceipt(canonical, input)
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error("unreachable")
        expect(result.code).toBe("degraded")
        expect(result.reason.length).toBeGreaterThan(0)
        // Restore permissions for cleanup
        await chmod(dirActivations, 0o755)
      }
    })

    test("Given a lock timeout When writeInjectionReceipt cannot acquire Then it returns degraded", async () => {
      const root = tempRoot()
      tempRoots.push(root)
      await mkdir(join(root, ".omo", "omp-lazy"), { recursive: true })
      const canonical = canonicalRoot(root)
      const input = makeInput()

      // Create a lock file to simulate contention
      const lockPath = join(root, ".omo", "omp-lazy", "state.lock")
      const { writeFileSync } = await import("node:fs")
      writeFileSync(
        lockPath,
        JSON.stringify({
          nonce: crypto.randomUUID(),
          pid: process.pid,
          sessionId: "blocker",
          purpose: "command",
          acquiredAt: new Date().toISOString(),
        }),
      )

      const result = await writeInjectionReceipt(canonical, input)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("unreachable")
      expect(result.code).toBe("degraded")
      expect(result.reason).toBe("lock_timeout")
    })
  })

  describe("schema compliance", () => {
    test("Given a receipt When it has empty matched and dropped arrays Then it still validates", async () => {
      const root = tempRoot()
      tempRoots.push(root)
      await mkdir(join(root, ".omo", "omp-lazy"), { recursive: true })
      const canonical = canonicalRoot(root)
      const input = makeInput({ matched: [], dropped: [] })

      const result = await writeInjectionReceipt(canonical, input)
      expect(result.ok).toBe(true)

      const filePath = join(
        root,
        ".omo",
        "omp-lazy",
        "directive-activations",
        "test-session-abc123.json",
      )
      const bytes = await readFile(filePath, "utf8")
      const parsed = JSON.parse(bytes)
      const validation = InjectionReceiptSchema.safeParse(parsed)
      expect(validation.success).toBe(true)
      expect(parsed.matched).toEqual([])
      expect(parsed.dropped).toEqual([])
    })

    test("Given a receipt When rule content is NOT included Then the file contains only metadata", async () => {
      const root = tempRoot()
      tempRoots.push(root)
      await mkdir(join(root, ".omo", "omp-lazy"), { recursive: true })
      const canonical = canonicalRoot(root)
      const input = makeInput()

      await writeInjectionReceipt(canonical, input)

      const filePath = join(
        root,
        ".omo",
        "omp-lazy",
        "directive-activations",
        "test-session-abc123.json",
      )
      const bytes = await readFile(filePath, "utf8")
      // Ensure the file does not contain any rule body text
      expect(bytes).not.toContain("console.log")
      expect(bytes).not.toContain("rule body")
      // Only file names are present
      expect(bytes).toContain("no-console.md")
      expect(bytes).toContain("lint-rules.md")
    })
  })

  describe("path guard compliance", () => {
    test("Given an invalid sessionId When writeInjectionReceipt is called Then it returns degraded (path guard rejects)", async () => {
      const root = tempRoot()
      tempRoots.push(root)
      await mkdir(join(root, ".omo", "omp-lazy"), { recursive: true })
      const canonical = canonicalRoot(root)

      // Invalid: contains path separator
      const input = makeInput({ sessionId: "../escape/attack" })
      const result = await writeInjectionReceipt(canonical, input)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("unreachable")
      expect(result.code).toBe("degraded")
    })

    test("Given a sessionId with nested path When path guard catches it Then write is refused", async () => {
      const root = tempRoot()
      tempRoots.push(root)
      await mkdir(join(root, ".omo", "omp-lazy"), { recursive: true })
      const canonical = canonicalRoot(root)

      const input = makeInput({ sessionId: "a/b" })
      const result = await writeInjectionReceipt(canonical, input)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("unreachable")
      expect(result.code).toBe("degraded")
    })

    test("Given an empty sessionId When writeInjectionReceipt is called Then it returns degraded", async () => {
      const root = tempRoot()
      tempRoots.push(root)
      await mkdir(join(root, ".omo", "omp-lazy"), { recursive: true })
      const canonical = canonicalRoot(root)

      const input = makeInput({ sessionId: "" })
      const result = await writeInjectionReceipt(canonical, input)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("unreachable")
      expect(result.code).toBe("degraded")
    })

    test("isValidLifecycleId rejects path-traversal patterns", () => {
      expect(isValidLifecycleId("../escape")).toBe(false)
      expect(isValidLifecycleId("a/b")).toBe(false)
      expect(isValidLifecycleId("")).toBe(false)
      expect(isValidLifecycleId(".hidden")).toBe(false)
      expect(isValidLifecycleId("-starts-with-dash")).toBe(false)
      expect(isValidLifecycleId("a".repeat(65))).toBe(false)
    })

    test("isValidLifecycleId accepts valid patterns", () => {
      expect(isValidLifecycleId("session123")).toBe(true)
      expect(isValidLifecycleId("a")).toBe(true)
      expect(isValidLifecycleId("A0")).toBe(true)
      expect(isValidLifecycleId("test-session.v1_abc")).toBe(true)
      expect(isValidLifecycleId("a".repeat(64))).toBe(true)
    })
  })
})
