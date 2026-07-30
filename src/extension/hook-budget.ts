import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import { HANDLER_COUNTS } from "./handler-budget"

/**
 * The declared handler budget — the canonical constant lives in `./handler-budget.ts`
 * inside the distributable `src/` tree so staged/copied candidates can resolve it.
 * `scripts/product-runtime-contract.ts` imports the same constant from here.
 */
export const HANDLER_BUDGET: Readonly<Record<string, number>> = {
  ...HANDLER_COUNTS,
} as const

export class HookBudgetError extends Error {
  override readonly name = "HookBudgetError"

  constructor(
    readonly event: string,
    readonly currentCount: number,
    readonly maxCount: number,
  ) {
    super(
      `HookBudgetError: event "${event}" already has ${currentCount}/${maxCount} registrations — budget exhausted`,
    )
  }
}

/**
 * Wraps `api.on` to enforce that no event exceeds its declared handler budget.
 * Every existing `api.on` call is routed through this class without adding,
 * removing, reordering, or changing any handler behavior.
 */
export class HookBudget {
  readonly #counts = new Map<string, number>()
  readonly #budget: Readonly<Record<string, number>>

  constructor(budget: Readonly<Record<string, number>>) {
    this.#budget = budget
  }

  /**
   * Register a handler for the given event, throwing HookBudgetError if the
   * declared budget for that event is already exhausted.
   */
  register(event: string, handler: unknown): void {
    const max = this.#budget[event]
    if (max === undefined) {
      throw new HookBudgetError(event, 0, 0)
    }
    const current = this.#counts.get(event) ?? 0
    if (current >= max) {
      throw new HookBudgetError(event, current, max)
    }
    this.#counts.set(event, current + 1)
    void handler
  }

  /** Current count for a given event (for diagnostics). */
  count(event: string): number {
    return this.#counts.get(event) ?? 0
  }
}

/**
 * Creates a guarded `api.on` wrapper that enforces the handler budget.
 * Returns a function with the same signature as `api.on` that validates
 * and then delegates to the real `api.on`.
 */
export function createBudgetedOn(
  realOn: (event: string, handler: unknown) => void,
  budget: HookBudget,
): (event: string, handler: unknown) => void {
  return (event: string, handler: unknown) => {
    budget.register(event, handler)
    realOn(event, handler)
  }
}

/**
 * Wraps an ExtensionAPI so that every `.on()` call is validated against the
 * handler budget before delegation. The returned object has the same type as
 * ExtensionAPI so all existing handler type inference is preserved.
 */
export function guardedApi(api: ExtensionAPI, budget: HookBudget): ExtensionAPI {
  const originalOn = api.on.bind(api)
  const wrappedOn: ExtensionAPI["on"] = ((event: string, handler: unknown) => {
    budget.register(event, handler)
    return (originalOn as (event: string, handler: unknown) => void)(event, handler)
  }) as ExtensionAPI["on"]

  return new Proxy(api, {
    get(target, prop, receiver) {
      if (prop === "on") return wrappedOn
      return Reflect.get(target, prop, receiver)
    },
  })
}
