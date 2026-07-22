import { z } from "zod"

export const UuidSchema = z.uuid().brand("Uuid")
export type Uuid = z.infer<typeof UuidSchema>

export type CanonicalRoot = {
  readonly canonicalPath: string
  readonly displayPath: string
}

export type WorkflowKind = "start_work" | "ulw_loop"
export type IndexStatusHint = "active" | "paused" | "stuck" | "blocked"

export type ActiveIndexEntry = {
  readonly workflow: WorkflowKind
  readonly sessionId: string
  readonly runId: Uuid
  readonly ownerEpoch: number
  readonly runRevision: number
  readonly transactionRevision: number
  readonly statusHint: IndexStatusHint
}

type ActiveIndexFields = {
  readonly revision: number
  readonly entries: readonly ActiveIndexEntry[]
}

export type ActiveIndex = ActiveIndexFields &
  (
    | { readonly schemaVersion: 1 }
    | { readonly schemaVersion: 2; readonly migrationRevision: number }
  )

type RunVersion =
  | { readonly schemaVersion: 1 }
  | {
      readonly schemaVersion: 2
      readonly packetHash: string | null
      readonly expectedHead: string | null
    }

export type StartWorkStatus =
  | "active"
  | "paused"
  | "stuck"
  | "completed"
  | "cancelled"
  | "failed"
  | "abandoned"

export type StartWorkPayload = {
  readonly kind: "start_work"
  readonly status: StartWorkStatus
  readonly plan: {
    readonly planId: Uuid
    readonly canonicalPath: string
    readonly displayPath: string
    readonly allowedRoot: string
    readonly allowedRootDisplay: string
    readonly taskFingerprint: string
    readonly taskIds: readonly string[]
  }
}

export type Criterion = {
  readonly id: string
  readonly status: "pending" | "pass" | "fail" | "blocked"
  readonly identicalFailureFingerprint: string | null
  readonly identicalFailureCount: number
  readonly evidenceRef: string | null
  readonly captureRevision: number | null
  readonly captureCommit: string | null
}

export type Goal = {
  readonly id: string
  readonly status:
    | "pending"
    | "in_progress"
    | "complete"
    | "failed"
    | "blocked"
    | "needs_user_decision"
    | "review_blocked"
  readonly cycleCount: number
  readonly criteria: readonly Criterion[]
}

export type UlwLoopPayload = {
  readonly kind: "ulw_loop"
  readonly status:
    | "active"
    | "paused"
    | "stuck"
    | "completed"
    | "cancelled"
    | "failed"
    | "blocked"
    | "needs_user_decision"
    | "review_blocked"
  readonly activeGoalId: string | null
  readonly goals: readonly Goal[]
}

export type RunEnvelope<
  P extends StartWorkPayload | UlwLoopPayload = StartWorkPayload | UlwLoopPayload,
> = RunVersion & {
  readonly runId: Uuid
  readonly workflow: P["kind"]
  readonly revision: number
  readonly transactionRevision: number
  readonly owner: { readonly sessionId: string; readonly epoch: number }
  readonly progressRevision: number
  readonly continuation: {
    readonly lastProcessedLeafId: string | null
    readonly progressRevisionSeen: number
    readonly noProgressAttempts: number
    readonly stuck: boolean
  }
  readonly createdAt: string
  readonly updatedAt: string
  readonly payload: P
}

export type StartWorkRun = RunEnvelope<StartWorkPayload>
export type UlwLoopRun = RunEnvelope<UlwLoopPayload>
export type AnyRun = StartWorkRun | UlwLoopRun

export type StateMutation =
  | { readonly kind: "run_created"; readonly run: AnyRun }
  | {
      readonly kind: "workflow_controlled"
      readonly control: "pause" | "resume" | "cancel"
    }
  | { readonly kind: "owner_adopted"; readonly sessionId: string }
  | {
      readonly kind: "plan_reconciled"
      readonly taskIds: readonly string[]
      readonly taskFingerprint: string
    }
  | {
      readonly kind: "continuation_attempted"
      readonly leafId: string
      readonly progressRevision: number
    }
  | { readonly kind: "continuation_stuck"; readonly leafId: string }
  | { readonly kind: "goal_cycle_started"; readonly goalId: string }
  | {
      readonly kind: "criterion_failure_recorded"
      readonly goalId: string
      readonly criterionId: string
      readonly fingerprint: string
    }

export type StateEvent = {
  readonly schemaVersion: 1
  readonly eventId: Uuid
  readonly sequence: number
  readonly runId: Uuid
  readonly workflow: WorkflowKind
  readonly kind: StateMutation["kind"]
  readonly expected: {
    readonly indexRevision: number
    readonly runRevision: number | null
    readonly ownerSessionId: string | null
    readonly ownerEpoch: number | null
  }
  readonly mutation: StateMutation
  readonly at: string
}

export type StateEventV2 = Omit<StateEvent, "schemaVersion" | "expected"> & {
  readonly schemaVersion: 2
  readonly expected: StateEvent["expected"] & {
    readonly expectedHead: string | null
    readonly taskGeneration: number | null
  }
  readonly legacyHeadUnbound: boolean
}

export type PersistedStateEvent = StateEvent | StateEventV2

export function newRunId(): Uuid {
  return UuidSchema.parse(crypto.randomUUID())
}
