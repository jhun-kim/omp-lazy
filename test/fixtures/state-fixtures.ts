import { decodeActiveIndex, decodeRun } from "../../src/state/codec"

export const ROOT = {
  canonicalPath: "c:/repo",
  displayPath: "C:\\repo",
} as const

export function validStartWorkJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    runId: "11111111-1111-4111-8111-111111111111",
    workflow: "start_work",
    revision: 2,
    transactionRevision: 4,
    owner: { sessionId: "session-a", epoch: 1 },
    progressRevision: 1,
    continuation: {
      lastProcessedLeafId: null,
      progressRevisionSeen: 1,
      noProgressAttempts: 0,
      stuck: false,
    },
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:01:00.000Z",
    payload: {
      kind: "start_work",
      status: "active",
      plan: {
        planId: "22222222-2222-4222-8222-222222222222",
        canonicalPath: "c:/repo/.omo/plans/work.md",
        displayPath: "C:\\repo\\.omo\\plans\\work.md",
        allowedRoot: "c:/repo",
        allowedRootDisplay: "C:\\repo",
        taskFingerprint: "a".repeat(64),
        taskIds: ["build state", "verify state"],
      },
    },
    ...overrides,
  })
}

export function validUlwLoopJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    runId: "33333333-3333-4333-8333-333333333333",
    workflow: "ulw_loop",
    revision: 3,
    transactionRevision: 4,
    owner: { sessionId: "session-a", epoch: 2 },
    progressRevision: 2,
    continuation: {
      lastProcessedLeafId: null,
      progressRevisionSeen: 2,
      noProgressAttempts: 0,
      stuck: false,
    },
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:01:00.000Z",
    payload: {
      kind: "ulw_loop",
      status: "active",
      activeGoalId: "goal-1",
      goals: [
        {
          id: "goal-1",
          status: "in_progress",
          cycleCount: 1,
          criteria: [
            {
              id: "criterion-1",
              status: "pending",
              identicalFailureFingerprint: null,
              identicalFailureCount: 0,
              evidenceRef: null,
              captureRevision: null,
              captureCommit: null,
            },
          ],
        },
      ],
    },
    ...overrides,
  })
}

export function startWorkRun() {
  const result = decodeRun(validStartWorkJson(), ROOT)
  if (!result.ok) throw result.error
  if (result.value.workflow !== "start_work") throw new Error("fixture workflow mismatch")
  return result.value
}

export function ulwLoopRun() {
  const result = decodeRun(validUlwLoopJson(), ROOT)
  if (!result.ok) throw result.error
  if (result.value.workflow !== "ulw_loop") throw new Error("fixture workflow mismatch")
  return result.value
}

export function activeIndex() {
  const result = decodeActiveIndex(
    JSON.stringify({
      schemaVersion: 1,
      revision: 4,
      entries: [
        {
          workflow: "start_work",
          sessionId: "session-a",
          runId: "11111111-1111-4111-8111-111111111111",
          ownerEpoch: 1,
          runRevision: 2,
          transactionRevision: 4,
          statusHint: "active",
        },
      ],
    }),
  )
  if (!result.ok) throw result.error
  return result.value
}
