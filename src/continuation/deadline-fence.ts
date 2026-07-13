import type { Deadline } from "../state/repo-lock"

export interface MonotonicClock {
  nowMs(): number
}

export class DeadlineFenceError extends Error {
  readonly name = "DeadlineFenceError"
  constructor(readonly code: "deadline_expired") {
    super(code)
  }
}

export interface DeadlineFence extends Deadline {
  readonly expiresAtMs: number
  assertValid(): void
  invalidate(): void
}

export function createDeadlineFence(
  durationMs: number,
  clock: MonotonicClock = { nowMs: () => performance.now() },
): DeadlineFence {
  const expiresAtMs = clock.nowMs() + Math.max(0, durationMs)
  let live = durationMs > 0
  const remainingMs = (): number => {
    if (!live) return 0
    const remaining = expiresAtMs - clock.nowMs()
    if (remaining <= 0) {
      live = false
      return 0
    }
    return remaining
  }
  return {
    expiresAtMs,
    remainingMs,
    isValid: () => remainingMs() > 0,
    assertValid: () => {
      if (remainingMs() <= 0) throw new DeadlineFenceError("deadline_expired")
    },
    invalidate: () => {
      live = false
    },
  }
}
