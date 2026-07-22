import { validateActiveIndex } from "./active-index"
import { activeIndexSchema, runSchema, stateEventSchema } from "./codec-schemas"
import type { ActiveIndex, AnyRun, CanonicalRoot, StateEvent } from "./domain"
import { isCanonicalPathContained } from "./paths"

type JsonRecord = Record<string, unknown> & {
  readonly schemaVersion?: unknown
  readonly expected?: unknown
}

export class StateDecodeError extends Error {
  readonly name = "StateDecodeError"
  constructor(readonly code: string) {
    super(code)
  }
}

export type DecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: StateDecodeError }

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

function without(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
}

function v1RunView(value: unknown): unknown {
  const input = record(value)
  return input?.schemaVersion === 2
    ? { ...without(input, ["packetHash", "expectedHead"]), schemaVersion: 1 }
    : value
}

function v1IndexView(value: unknown): unknown {
  const input = record(value)
  return input?.schemaVersion === 2
    ? { ...without(input, ["migrationRevision"]), schemaVersion: 1 }
    : value
}

function v1EventView(value: unknown): unknown {
  const input = record(value)
  const expected = input === null ? null : record(input.expected)
  if (input?.schemaVersion !== 2 || expected === null) return value
  return {
    ...without(input, ["legacyAuditOnly"]),
    schemaVersion: 1,
    expected: { ...without(expected, ["expectedHead", "taskGeneration"]) },
  }
}

function parseJson(bytes: string): DecodeResult<unknown> {
  try {
    const value: unknown = JSON.parse(bytes)
    return { ok: true, value }
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { ok: false, error: new StateDecodeError("malformed_json") }
    }
    throw error
  }
}

export function decodeRun(bytes: string, root: CanonicalRoot): DecodeResult<AnyRun> {
  const json = parseJson(bytes)
  if (!json.ok) return json
  const parsed = runSchema.safeParse(v1RunView(json.value))
  if (!parsed.success) return { ok: false, error: new StateDecodeError("malformed_run") }
  if (parsed.data.workflow === "start_work") {
    const plan = parsed.data.payload.plan
    if (
      plan.allowedRoot !== root.canonicalPath ||
      !isCanonicalPathContained(plan.allowedRoot, plan.canonicalPath)
    ) {
      return { ok: false, error: new StateDecodeError("path_mismatch") }
    }
  }
  return { ok: true, value: parsed.data }
}

export function decodeActiveIndex(bytes: string): DecodeResult<ActiveIndex> {
  const json = parseJson(bytes)
  if (!json.ok) return json
  const parsed = activeIndexSchema.safeParse(v1IndexView(json.value))
  if (!parsed.success) return { ok: false, error: new StateDecodeError("malformed_index") }
  const invariant = validateActiveIndex(parsed.data)
  return invariant.ok
    ? { ok: true, value: parsed.data }
    : { ok: false, error: new StateDecodeError(invariant.code) }
}

export function decodeStateEvent(bytes: string): DecodeResult<StateEvent> {
  const json = parseJson(bytes)
  if (!json.ok) return json
  const parsed = stateEventSchema.safeParse(v1EventView(json.value))
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: new StateDecodeError("malformed_event") }
}
