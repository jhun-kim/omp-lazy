import { describe, expect, test } from "bun:test"
import type { ExtensionContext, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent"
import {
  composeStatusLine,
  deriveModelRole,
  deriveProgress,
  STATUS_KEY,
  STATUS_TEXT_MAX,
  StatusLinePublisher,
  sanitizeStatusText,
  shortRunId,
} from "../../src/observers/status-line-publisher"

// ─── Fake context that records setStatus / setWorkingMessage calls ───────────

type UICall =
  | { method: "setStatus"; key: string; text: string | undefined }
  | { method: "setWorkingMessage"; message: string | undefined }

/**
 * Creates a fake ExtensionContext with the given `hasUI` flag and a UI
 * that records calls. When `hasUI` is false, the UI methods still exist
 * but should never be called by the publisher.
 */
function createFakeContext(opts?: {
  hasUI?: boolean
  throwOnSetStatus?: boolean
  throwOnSetWorkingMessage?: boolean
}): { ctx: ExtensionContext; calls: UICall[] } {
  const calls: UICall[] = []
  const ui = {
    setStatus(key: string, text: string | undefined): void {
      if (opts?.throwOnSetStatus) throw new Error("setStatus exploded")
      calls.push({ method: "setStatus", key, text })
    },
    setWorkingMessage(message?: string): void {
      if (opts?.throwOnSetWorkingMessage) throw new Error("setWorkingMessage exploded")
      calls.push({ method: "setWorkingMessage", message })
    },
  } as unknown as ExtensionUIContext
  const ctx = {
    hasUI: opts?.hasUI ?? true,
    ui,
  } as unknown as ExtensionContext
  return { ctx, calls }
}

// ─── Fake model context for deriveModelRole ─────────────────────────────────

function createFakeModelContext(opts: {
  modelId?: string
  family?: string
  roleResolutions?: Record<string, { id: string; family: string } | undefined>
}): Pick<ExtensionContext, "model" | "models"> {
  const model = opts.modelId !== undefined ? { id: opts.modelId, provider: "test" } : undefined
  const models = {
    resolve(spec: string) {
      const resolved = opts.roleResolutions?.[spec]
      return resolved !== undefined ? { id: resolved.id, provider: "test" } : undefined
    },
    family(m: { id: string }) {
      if (m.id === opts.modelId) return opts.family ?? "default-family"
      const resolution = Object.values(opts.roleResolutions ?? {}).find((r) => r?.id === m.id)
      return resolution?.family ?? "other-family"
    },
    list: () => [],
    current: () => undefined,
  }
  return { model, models } as unknown as Pick<ExtensionContext, "model" | "models">
}

// ─── Unit tests ─────────────────────────────────────────────────────────────

describe("status-line-publisher: composeStatusLine", () => {
  test("composes all fields for start_work with model role", () => {
    expect(
      composeStatusLine({
        workflow: "start_work",
        runIdShort: "a1b2c3d4",
        progress: "3/7",
        modelRole: "@slow",
      }),
    ).toBe("[start_work] a1b2c3d4 3/7 | @slow")
  })

  test("composes all fields for ulw_loop with model role", () => {
    expect(
      composeStatusLine({
        workflow: "ulw_loop",
        runIdShort: "f9e8d7c6",
        progress: "2/4 goals",
        modelRole: "@task",
      }),
    ).toBe("[ulw_loop] f9e8d7c6 2/4 goals | @task")
  })

  test("omits role section when modelRole is null", () => {
    expect(
      composeStatusLine({
        workflow: "start_work",
        runIdShort: "abcdef12",
        progress: "active",
        modelRole: null,
      }),
    ).toBe("[start_work] abcdef12 active")
  })
})

describe("status-line-publisher: shortRunId", () => {
  test("returns first 8 characters of a UUID", () => {
    expect(shortRunId("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe("a1b2c3d4")
  })

  test("handles short strings gracefully", () => {
    expect(shortRunId("abc")).toBe("abc")
  })
})

describe("status-line-publisher: deriveProgress", () => {
  test("start_work shows progressRevision/total tasks", () => {
    const run = {
      workflow: "start_work",
      payload: {
        status: "active",
        plan: { taskIds: ["T1", "T2", "T3", "T4", "T5"] },
      },
      progressRevision: 3,
    }
    expect(deriveProgress(run)).toBe("3/5")
  })

  test("ulw_loop shows completed/total goals", () => {
    const run = {
      workflow: "ulw_loop",
      payload: {
        status: "active",
        goals: [
          { status: "complete", criteria: [] },
          { status: "complete", criteria: [] },
          { status: "in_progress", criteria: [] },
          { status: "pending", criteria: [] },
        ],
      },
      progressRevision: 2,
    }
    expect(deriveProgress(run)).toBe("2/4 goals")
  })

  test("falls back to status when no plan or goals", () => {
    const run = {
      workflow: "start_work",
      payload: { status: "blocked" },
      progressRevision: 0,
    }
    expect(deriveProgress(run)).toBe("blocked")
  })
})

describe("status-line-publisher: deriveModelRole", () => {
  test("returns matching alias when model family matches", () => {
    const ctx = createFakeModelContext({
      modelId: "anthropic/claude-sonnet",
      family: "claude-family",
      roleResolutions: {
        "@slow": { id: "anthropic/claude-sonnet", family: "claude-family" },
        "@task": { id: "anthropic/claude-haiku", family: "haiku-family" },
        "@smol": { id: "openai/gpt-mini", family: "gpt-family" },
      },
    })
    expect(deriveModelRole(ctx)).toBe("@slow")
  })

  test("returns null when no model is set", () => {
    const ctx = createFakeModelContext({})
    expect(deriveModelRole(ctx)).toBeNull()
  })

  test("returns null when model does not match any alias", () => {
    const ctx = createFakeModelContext({
      modelId: "unknown/model",
      family: "unknown-family",
      roleResolutions: {
        "@smol": { id: "openai/gpt-mini", family: "gpt-family" },
        "@task": { id: "anthropic/claude-haiku", family: "haiku-family" },
        "@slow": { id: "anthropic/claude-sonnet", family: "claude-family" },
      },
    })
    expect(deriveModelRole(ctx)).toBeNull()
  })
})

describe("status-line-publisher: StatusLinePublisher", () => {
  test("setRunStatus calls setStatus with the namespaced key and composed line", () => {
    const { ctx, calls } = createFakeContext()
    const pub = new StatusLinePublisher()
    pub.setRunStatus(ctx, {
      workflow: "start_work",
      runIdShort: "a1b2c3d4",
      progress: "2/5",
      modelRole: "@task",
    })
    expect(calls).toEqual([
      { method: "setStatus", key: STATUS_KEY, text: "[start_work] a1b2c3d4 2/5 | @task" },
    ])
    expect(pub.lastStatus).toBe("[start_work] a1b2c3d4 2/5 | @task")
  })

  test("setWorking calls setWorkingMessage with the dispatch message", () => {
    const { ctx, calls } = createFakeContext()
    const pub = new StatusLinePublisher()
    pub.setWorking(ctx, "omp-lazy: dispatching task")
    expect(calls).toEqual([{ method: "setWorkingMessage", message: "omp-lazy: dispatching task" }])
    expect(pub.lastWorkingMessage).toBe("omp-lazy: dispatching task")
  })

  test("clear clears both status and working message", () => {
    const { ctx, calls } = createFakeContext()
    const pub = new StatusLinePublisher()

    // Set first
    pub.setRunStatus(ctx, {
      workflow: "ulw_loop",
      runIdShort: "deadbeef",
      progress: "1/3 goals",
      modelRole: "@slow",
    })
    pub.setWorking(ctx, "omp-lazy: dispatching read")

    // Clear all calls record then clear
    calls.length = 0
    pub.clear(ctx)

    expect(calls).toEqual([
      { method: "setStatus", key: STATUS_KEY, text: undefined },
      { method: "setWorkingMessage", message: undefined },
    ])
    expect(pub.lastStatus).toBeNull()
    expect(pub.lastWorkingMessage).toBeNull()
  })

  test("stale state: status from a finished run does not linger after shutdown", () => {
    const { ctx, calls } = createFakeContext()
    const pub = new StatusLinePublisher()

    // Simulate a run that sets status
    pub.setRunStatus(ctx, {
      workflow: "start_work",
      runIdShort: "11223344",
      progress: "5/5",
      modelRole: "@task",
    })
    expect(pub.lastStatus).not.toBeNull()

    // Simulate shutdown clearing
    pub.clear(ctx)
    expect(pub.lastStatus).toBeNull()
    expect(pub.lastWorkingMessage).toBeNull()

    // Verify the clear calls were made
    const clearCalls = calls.filter(
      (c) =>
        (c.method === "setStatus" && c.text === undefined) ||
        (c.method === "setWorkingMessage" && c.message === undefined),
    )
    expect(clearCalls.length).toBe(2)
  })

  test("malformed input: a run with no plan progress still produces a valid single-line status", () => {
    const { ctx, calls } = createFakeContext()
    const pub = new StatusLinePublisher()

    // Run with no plan progress (falls back to status text)
    pub.setRunStatus(ctx, {
      workflow: "start_work",
      runIdShort: "aabbccdd",
      progress: deriveProgress({
        workflow: "start_work",
        payload: { status: "active" },
        progressRevision: 0,
      }),
      modelRole: null,
    })

    expect(calls.length).toBe(1)
    const statusCall = calls[0]
    expect(statusCall).toBeDefined()
    expect(statusCall?.method).toBe("setStatus")
    if (statusCall?.method === "setStatus") {
      expect(statusCall.text).toBe("[start_work] aabbccdd active")
      // Valid single line: no newlines
      expect(statusCall.text?.includes("\n")).toBe(false)
      expect(statusCall.text?.includes("\r")).toBe(false)
    }
  })

  // ─── Todo 24: Fail-safe and sanitization tests ─────────────────────────────

  test("headless context (hasUI=false) performs zero UI calls", () => {
    const { ctx, calls } = createFakeContext({ hasUI: false })
    const pub = new StatusLinePublisher()

    pub.setRunStatus(ctx, {
      workflow: "start_work",
      runIdShort: "a1b2c3d4",
      progress: "3/7",
      modelRole: "@slow",
    })
    pub.setWorking(ctx, "omp-lazy: dispatching task")
    pub.clear(ctx)

    expect(calls).toHaveLength(0)
    expect(pub.lastStatus).toBeNull()
    expect(pub.lastWorkingMessage).toBeNull()
    expect(pub.degradations).toHaveLength(0)
  })

  test("throwing setStatus leaves handler result unchanged and records degradation", () => {
    const { ctx, calls } = createFakeContext({ throwOnSetStatus: true })
    const pub = new StatusLinePublisher()

    // Does not throw
    pub.setRunStatus(ctx, {
      workflow: "start_work",
      runIdShort: "a1b2c3d4",
      progress: "2/5",
      modelRole: "@task",
    })

    // The status was composed and stored internally
    expect(pub.lastStatus).toBe("[start_work] a1b2c3d4 2/5 | @task")
    // No UI calls succeeded
    expect(calls).toHaveLength(0)
    // Degradation recorded
    expect(pub.degradations).toHaveLength(1)
    expect(pub.degradations[0]?.kind).toBe("ui_degradation")
    expect(pub.degradations[0]?.method).toBe("setStatus")
    expect(pub.degradations[0]?.error).toBe("setStatus exploded")
  })

  test("throwing setWorkingMessage leaves handler result unchanged and records degradation", () => {
    const { ctx, calls } = createFakeContext({ throwOnSetWorkingMessage: true })
    const pub = new StatusLinePublisher()

    pub.setWorking(ctx, "omp-lazy: dispatching task")

    expect(pub.lastWorkingMessage).toBe("omp-lazy: dispatching task")
    expect(calls).toHaveLength(0)
    expect(pub.degradations).toHaveLength(1)
    expect(pub.degradations[0]?.kind).toBe("ui_degradation")
    expect(pub.degradations[0]?.method).toBe("setWorkingMessage")
    expect(pub.degradations[0]?.error).toBe("setWorkingMessage exploded")
  })

  test("ANSI escapes, CRLF, and NUL in goal title are sanitized to single capped line", () => {
    const { ctx, calls } = createFakeContext()
    const pub = new StatusLinePublisher()

    // Goal title with ANSI escape, CRLF, and NUL byte
    const hostileTitle = "\x1b[31mEvil\x1b[0m\r\nSecond Line\x00Hidden"
    pub.setRunStatus(ctx, {
      workflow: "start_work",
      runIdShort: "deadbeef",
      progress: hostileTitle,
      modelRole: "@task",
    })

    expect(calls).toHaveLength(1)
    const emitted = calls[0]
    expect(emitted).toBeDefined()
    expect(emitted?.method).toBe("setStatus")
    if (emitted?.method === "setStatus") {
      // Single line: no CR, LF, NUL, or ESC - use charCodeAt checks instead of regex
      // to avoid lint issues with control characters in regex
      const text = emitted.text ?? ""
      for (const ch of text) {
        const code = ch.charCodeAt(0)
        expect(code).not.toBe(0x00) // NUL
        expect(code).not.toBe(0x1b) // ESC
        expect(code).not.toBe(0x0d) // CR
        expect(code).not.toBe(0x0a) // LF
      }
      // The result is on a single line
      expect(text.split("\n")).toHaveLength(1)
      // Contains the sanitized text content
      expect(text).toContain("Evil")
      expect(text).toContain("Hidden")
    }
  })

  test("long text is capped at STATUS_TEXT_MAX characters", () => {
    const { ctx, calls } = createFakeContext()
    const pub = new StatusLinePublisher()

    const longProgress = "A".repeat(10000)
    pub.setRunStatus(ctx, {
      workflow: "start_work",
      runIdShort: "12345678",
      progress: longProgress,
      modelRole: "@task",
    })

    expect(calls).toHaveLength(1)
    const emitted = calls[0]
    expect(emitted).toBeDefined()
    if (emitted?.method === "setStatus") {
      // Capped to STATUS_TEXT_MAX code points (including ellipsis)
      const codePoints = [...(emitted.text ?? "")]
      expect(codePoints.length).toBeLessThanOrEqual(STATUS_TEXT_MAX)
      // Ends with ellipsis
      expect(emitted.text).toMatch(/…$/)
    }
  })

  test("sanitizeStatusText: empty string yields empty", () => {
    expect(sanitizeStatusText("")).toBe("")
  })

  test("sanitizeStatusText: only control characters yield empty", () => {
    expect(sanitizeStatusText("\x00\x01\x1b\r\n")).toBe("")
  })

  test("sanitizeStatusText: astral-plane characters are not split", () => {
    // Emoji flag sequence (2 code points) with cap=2 should not split
    const emoji = "🇰🇷" // two regional indicator symbols
    const result = sanitizeStatusText(emoji, 2)
    // Must be complete without lone surrogates
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(result).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  test("sanitizeStatusText: collapses format characters (zero-width joiners, BOM)", () => {
    const input = "a\u200B\u200C\u200D\uFEFFb"
    expect(sanitizeStatusText(input)).toBe("a b")
  })
})
