import { z } from "zod"

export const PROXY_SCOPE_HEADER = "x-omp-harness-scope"
export const PROXY_CALL_ID_HEADER = "x-omp-harness-call-id"
export const PROXY_TERMINAL_HEADER = "x-omp-harness-terminal"

const scopeIdSchema = z.string().regex(/^[a-f0-9]{32}$/)
const actorRouteSchema = z.string().regex(/^\/actor\/[a-z][a-z0-9._-]{0,63}$/)
const proxyCallIdSchema = z.coerce.number().int().positive()
export const ProxyTerminalStateSchema = z.enum([
  "responded",
  "errored",
  "transport_client_disconnected",
])
export type ProxyTerminalState = z.infer<typeof ProxyTerminalStateSchema>

const modelRouteSchema = z
  .object({
    provider: z.string().min(1),
    id: z.string().min(1),
    baseUrl: z.url(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .passthrough()

const proxyTerminalSchema = z
  .object({
    scopeId: scopeIdSchema,
    configuredActorRoute: actorRouteSchema,
    proxyCallId: z.number().int().positive(),
    terminal: ProxyTerminalStateSchema,
  })
  .strict()

export type StaticActorTrialScope = {
  readonly scopeId: string
  readonly configuredActorRoute: string
  readonly provider: string
  readonly modelId: string
}

export type ModelCallRecord = StaticActorTrialScope & {
  readonly packetHash: string
  readonly proxyCallId: number
  readonly retryAttempt: number
  readonly terminal: ProxyTerminalState
}

export type ModelCallSnapshot = {
  readonly calls: readonly ModelCallRecord[]
  readonly pendingCalls: number
}

type PendingCall = {
  readonly scope: StaticActorTrialScope
  readonly packetHash: string
  readonly retryAttempt: number
}

type MutableModelState = {
  readonly calls: ModelCallRecord[]
  readonly pending: PendingCall[]
  nextRetryAttempt: number
}

export type ModelCallResult =
  | { readonly kind: "quiet" }
  | { readonly kind: "accepted"; readonly retryAttempt: number }
  | { readonly kind: "recorded"; readonly call: ModelCallRecord }
  | {
      readonly kind: "refused"
      readonly code:
        | "proxy_call_id_missing"
        | "proxy_call_id_replayed"
        | "proxy_terminal_invalid"
        | "proxy_terminal_source_invalid"
        | "proxy_scope_mismatch"
        | "proxy_call_uncorrelated"
    }

type ResponseHeaders = Headers | Readonly<Record<string, string>>

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name)
  return entry?.[1]
}

function responseHeader(headers: ResponseHeaders, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name)
  return headerValue(headers, name) ?? null
}

export function parseStaticActorTrialScope(modelValue: unknown): StaticActorTrialScope | null {
  const parsed = modelRouteSchema.safeParse(modelValue)
  if (!parsed.success) return null
  let url: URL
  try {
    url = new URL(parsed.data.baseUrl)
  } catch (error) {
    if (error instanceof TypeError) return null
    throw error
  }
  const routeMatch = /\/actor\/[a-z][a-z0-9._-]{0,63}$/.exec(url.pathname)
  const configuredActorRoute = routeMatch?.[0]
  const scopeId =
    parsed.data.headers === undefined
      ? undefined
      : headerValue(parsed.data.headers, PROXY_SCOPE_HEADER)
  const route = actorRouteSchema.safeParse(configuredActorRoute)
  const scope = scopeIdSchema.safeParse(scopeId)
  if (!route.success || !scope.success) return null
  return {
    scopeId: scope.data,
    configuredActorRoute: route.data,
    provider: parsed.data.provider,
    modelId: parsed.data.id,
  }
}

function stateFor(states: Map<string, MutableModelState>, sessionId: string): MutableModelState {
  const current = states.get(sessionId)
  if (current !== undefined) return current
  const created: MutableModelState = { calls: [], pending: [], nextRetryAttempt: 0 }
  states.set(sessionId, created)
  return created
}

function lastCallId(state: MutableModelState, scopeId: string): number {
  return state.calls
    .filter((call) => call.scopeId === scopeId)
    .reduce((largest, call) => Math.max(largest, call.proxyCallId), 0)
}

export class ModelCallObserver {
  readonly #states = new Map<string, MutableModelState>()

  clear(sessionId: string): void {
    this.#states.delete(sessionId)
  }

  begin(sessionId: string, packetHash: string, model: unknown): ModelCallResult {
    const scope = parseStaticActorTrialScope(model)
    if (scope === null) return { kind: "quiet" }
    const state = stateFor(this.#states, sessionId)
    const retryAttempt = state.nextRetryAttempt
    state.nextRetryAttempt = 0
    state.pending.push({ scope, packetHash, retryAttempt })
    return { kind: "accepted", retryAttempt }
  }

  retryStarted(
    sessionId: string,
    retry: { readonly attempt: number; readonly maxAttempts: number },
  ): void {
    if (retry.attempt < 1 || retry.attempt > retry.maxAttempts) return
    stateFor(this.#states, sessionId).nextRetryAttempt = retry.attempt
  }

  observeResponse(
    sessionId: string,
    response: { readonly status: number; readonly headers: ResponseHeaders },
  ): ModelCallResult {
    const state = this.#states.get(sessionId)
    const pending = state?.pending.shift()
    if (state === undefined || pending === undefined) {
      return { kind: "refused", code: "proxy_call_uncorrelated" }
    }
    const callId = proxyCallIdSchema.safeParse(
      responseHeader(response.headers, PROXY_CALL_ID_HEADER),
    )
    if (!callId.success) return { kind: "refused", code: "proxy_call_id_missing" }
    const claimedTerminal = responseHeader(response.headers, PROXY_TERMINAL_HEADER)
    const terminal =
      claimedTerminal === null
        ? response.status >= 200 && response.status < 400
          ? "responded"
          : "errored"
        : ProxyTerminalStateSchema.safeParse(claimedTerminal).data
    if (terminal === undefined) return { kind: "refused", code: "proxy_terminal_invalid" }
    if (terminal === "transport_client_disconnected") {
      return { kind: "refused", code: "proxy_terminal_source_invalid" }
    }
    if (
      (terminal === "responded" && (response.status < 200 || response.status >= 400)) ||
      (terminal === "errored" && response.status >= 200 && response.status < 400)
    ) {
      return { kind: "refused", code: "proxy_terminal_invalid" }
    }
    return this.#record(state, pending, callId.data, terminal)
  }

  observeProxyTerminal(sessionId: string, terminalValue: unknown): ModelCallResult {
    const terminal = proxyTerminalSchema.safeParse(terminalValue)
    if (!terminal.success) return { kind: "refused", code: "proxy_terminal_invalid" }
    const state = this.#states.get(sessionId)
    if (state === undefined) return { kind: "refused", code: "proxy_call_uncorrelated" }
    const position = state.pending.findIndex(
      (pending) =>
        pending.scope.scopeId === terminal.data.scopeId &&
        pending.scope.configuredActorRoute === terminal.data.configuredActorRoute,
    )
    if (position < 0) return { kind: "refused", code: "proxy_scope_mismatch" }
    const pending = state.pending.splice(position, 1)[0]
    if (pending === undefined) return { kind: "refused", code: "proxy_call_uncorrelated" }
    return this.#record(state, pending, terminal.data.proxyCallId, terminal.data.terminal)
  }

  snapshot(sessionId: string): ModelCallSnapshot | null {
    const state = this.#states.get(sessionId)
    return state === undefined
      ? null
      : { calls: [...state.calls], pendingCalls: state.pending.length }
  }

  #record(
    state: MutableModelState,
    pending: PendingCall,
    proxyCallId: number,
    terminal: ProxyTerminalState,
  ): ModelCallResult {
    if (proxyCallId <= lastCallId(state, pending.scope.scopeId)) {
      return { kind: "refused", code: "proxy_call_id_replayed" }
    }
    const call: ModelCallRecord = {
      ...pending.scope,
      packetHash: pending.packetHash,
      proxyCallId,
      retryAttempt: pending.retryAttempt,
      terminal,
    }
    state.calls.push(call)
    return { kind: "recorded", call }
  }
}
