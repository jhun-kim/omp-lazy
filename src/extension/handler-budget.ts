/**
 * Canonical handler-budget constant — the single source of truth for the
 * maximum number of `api.on()` registrations allowed per event name.
 *
 * This constant lives inside `src/` so it remains resolvable when the
 * extension is loaded from a copied, staged, or tarball-installed directory.
 * `scripts/product-runtime-contract.ts` imports this value; never the reverse.
 */
export const HANDLER_COUNTS = {
  after_provider_response: 1,
  auto_retry_start: 1,
  before_agent_start: 1,
  context: 1,
  input: 1,
  session_shutdown: 1,
  session_stop: 1,
  tool_call: 2,
  tool_result: 2,
} as const

export type HandlerCounts = typeof HANDLER_COUNTS
