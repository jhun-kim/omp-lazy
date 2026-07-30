import { describe, expect, test } from "bun:test"
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import { expectedProductRuntime } from "../../../scripts/product-runtime-contract"
import { HANDLER_COUNTS } from "../../../src/extension/handler-budget"
import { HookBudget, HookBudgetError } from "../../../src/extension/hook-budget"

/**
 * Baseline characterization: pins the existing registration set (event name -> count and order)
 * using a fake ExtensionAPI that records all api.on calls.
 */
describe("hook-budget baseline characterization", () => {
  test("existing registrations match expected event names, counts and order", async () => {
    const registrations: Array<{ event: string; index: number }> = []
    let callIndex = 0

    const fakeApi = {
      on: (event: string, _handler: unknown) => {
        registrations.push({ event, index: callIndex++ })
      },
      registerCommand: () => {},
      registerTool: () => {},
      sendMessage: () => {},
      sendUserMessage: () => {},
    } as unknown as ExtensionAPI

    const { registerOmpLazyExtension } = await import("../../../src/extension/register-extension")
    registerOmpLazyExtension(fakeApi)

    // Verify the exact order of registrations
    const expectedOrder = [
      "input",
      "before_agent_start",
      "session_stop",
      "context",
      "tool_call",
      "tool_result",
      "after_provider_response",
      "auto_retry_start",
      "session_shutdown",
      "tool_call",
      "tool_result",
    ]
    expect(registrations.map((r) => r.event)).toEqual(expectedOrder)

    // Verify the counts match product-runtime-contract handlerCounts
    const counts: Record<string, number> = {}
    for (const r of registrations) {
      counts[r.event] = (counts[r.event] ?? 0) + 1
    }
    // Sort for comparison
    const sortedCounts = Object.fromEntries(
      Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
    )
    expect(sortedCounts).toEqual(expectedProductRuntime.handlerCounts)
  })

  test("total registration count is 11 (9 unique events, some with multiple handlers)", async () => {
    let count = 0
    const fakeApi = {
      on: (_event: string, _handler: unknown) => {
        count++
      },
      registerCommand: () => {},
      registerTool: () => {},
      sendMessage: () => {},
      sendUserMessage: () => {},
    } as unknown as ExtensionAPI

    const { registerOmpLazyExtension } = await import("../../../src/extension/register-extension")
    registerOmpLazyExtension(fakeApi)
    expect(count).toBe(11)
  })
})

describe("hook-budget enforcement", () => {
  test("a second context registration throws HookBudgetError naming the event", () => {
    const budget = new HookBudget(expectedProductRuntime.handlerCounts)

    // First context registration is fine
    budget.register("context", () => {})

    // Second context registration must throw
    expect(() => budget.register("context", () => {})).toThrow(HookBudgetError)
    try {
      budget.register("context", () => {})
    } catch (error) {
      expect(error).toBeInstanceOf(HookBudgetError)
      expect((error as Error).message).toContain("context")
    }
  })

  test("a third tool_call registration throws HookBudgetError naming the event", () => {
    const budget = new HookBudget(expectedProductRuntime.handlerCounts)

    // First and second tool_call registrations are fine (budget is 2)
    budget.register("tool_call", () => {})
    budget.register("tool_call", () => {})

    // Third tool_call registration must throw
    expect(() => budget.register("tool_call", () => {})).toThrow(HookBudgetError)
    try {
      budget.register("tool_call", () => {})
    } catch (error) {
      expect(error).toBeInstanceOf(HookBudgetError)
      expect((error as Error).message).toContain("tool_call")
    }
  })

  test("budget constant matches scripts/product-runtime-contract.ts handlerCounts exactly", async () => {
    const { HANDLER_BUDGET } = await import("../../../src/extension/hook-budget")
    // Three-way equality: src/extension/handler-budget.ts (canonical) ===
    // src/extension/hook-budget.ts (spread) === scripts/product-runtime-contract.ts (imported)
    expect(HANDLER_BUDGET).toEqual(expectedProductRuntime.handlerCounts)
    expect(HANDLER_BUDGET).toEqual(HANDLER_COUNTS)
    expect(HANDLER_COUNTS).toEqual(expectedProductRuntime.handlerCounts)
  })

  test("all registrations through HookBudget succeed when within budget", () => {
    const budget = new HookBudget(expectedProductRuntime.handlerCounts)

    // Register all at their declared budget
    for (const [event, count] of Object.entries(expectedProductRuntime.handlerCounts)) {
      for (let i = 0; i < count; i++) {
        expect(() => budget.register(event, () => {})).not.toThrow()
      }
    }
  })

  test("an unbudgeted event throws HookBudgetError", () => {
    const budget = new HookBudget(expectedProductRuntime.handlerCounts)

    expect(() => budget.register("unknown_event", () => {})).toThrow(HookBudgetError)
    try {
      budget.register("unknown_event", () => {})
    } catch (error) {
      expect(error).toBeInstanceOf(HookBudgetError)
      expect((error as Error).message).toContain("unknown_event")
    }
  })
})
