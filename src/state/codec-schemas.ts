import { z } from "zod"
import { UuidSchema } from "./domain"

const counter = z.number().int().nonnegative()
const nonempty = z.string().trim().min(1)
const timestamp = z.iso.datetime({ offset: true })
const uniqueStrings = z
  .array(nonempty)
  .readonly()
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: "duplicate id" })
    }
  })
const continuationSchema = z
  .object({
    lastProcessedLeafId: nonempty.nullable(),
    progressRevisionSeen: counter,
    noProgressAttempts: counter,
    stuck: z.boolean(),
  })
  .strict()
const envelopeFields = {
  runId: UuidSchema,
  revision: counter,
  transactionRevision: counter,
  owner: z.object({ sessionId: nonempty, epoch: counter }).strict(),
  progressRevision: counter,
  continuation: continuationSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
} as const
const v2EnvelopeFields = {
  packetHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  expectedHead: nonempty.nullable(),
} as const
const planSchema = z
  .object({
    planId: UuidSchema,
    canonicalPath: nonempty,
    displayPath: nonempty,
    allowedRoot: nonempty,
    allowedRootDisplay: nonempty,
    taskFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    taskIds: uniqueStrings,
  })
  .strict()
const startWorkFields = {
  ...envelopeFields,
  workflow: z.literal("start_work"),
  payload: z
    .object({
      kind: z.literal("start_work"),
      status: z.enum([
        "active",
        "paused",
        "blocked",
        "needs_user_decision",
        "review_blocked",
        "stuck",
        "completed",
        "cancelled",
        "failed",
        "abandoned",
      ]),
      plan: planSchema,
    })
    .strict(),
} as const
const startWorkRunSchema = z
  .object({
    schemaVersion: z.literal(1),
    ...startWorkFields,
  })
  .strict()
const startWorkRunV2Schema = z
  .object({ schemaVersion: z.literal(2), ...startWorkFields, ...v2EnvelopeFields })
  .strict()
const criterionSchema = z
  .object({
    id: nonempty,
    scenario: nonempty.optional(),
    observable: nonempty.optional(),
    evidenceLogicalId: nonempty.optional(),
    status: z.enum(["pending", "pass", "fail", "blocked"]),
    identicalFailureFingerprint: nonempty.nullable(),
    identicalFailureCount: counter.max(3),
    evidenceRef: nonempty.nullable(),
    captureRevision: counter.nullable(),
    captureCommit: nonempty.nullable(),
  })
  .strict()
const goalSchema = z
  .object({
    id: nonempty,
    status: z.enum([
      "pending",
      "in_progress",
      "complete",
      "failed",
      "blocked",
      "needs_user_decision",
      "review_blocked",
    ]),
    cycleCount: counter.max(5),
    criteria: z.array(criterionSchema).readonly(),
  })
  .strict()
  .superRefine((goal, context) => {
    const ids = goal.criteria.map((criterion) => criterion.id)
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "duplicate criterion" })
    }
  })
const ulwLoopFields = {
  ...envelopeFields,
  workflow: z.literal("ulw_loop"),
  payload: z
    .object({
      kind: z.literal("ulw_loop"),
      objective: nonempty.optional(),
      annotation: z.string().max(512).optional(),
      status: z.enum([
        "active",
        "paused",
        "stuck",
        "completed",
        "cancelled",
        "failed",
        "blocked",
        "needs_user_decision",
        "review_blocked",
      ]),
      activeGoalId: nonempty.nullable(),
      goals: z.array(goalSchema).readonly(),
    })
    .strict(),
} as const

function refineUlwLoop(
  run: { readonly payload: z.infer<typeof ulwLoopFields.payload> },
  context: z.core.$RefinementCtx,
): void {
  const goalIds = run.payload.goals.map((goal) => goal.id)
  const criterionIds = run.payload.goals.flatMap((goal) =>
    goal.criteria.map((criterion) => criterion.id),
  )
  if (new Set(goalIds).size !== goalIds.length) {
    context.addIssue({ code: "custom", message: "duplicate goal", input: run })
  }
  if (new Set(criterionIds).size !== criterionIds.length) {
    context.addIssue({ code: "custom", message: "duplicate criterion", input: run })
  }
  const inProgress = run.payload.goals.filter((goal) => goal.status === "in_progress")
  const activeMatches = inProgress.length === 1 && inProgress[0]?.id === run.payload.activeGoalId
  if (
    (run.payload.activeGoalId === null && inProgress.length !== 0) ||
    (run.payload.activeGoalId !== null && !activeMatches)
  ) {
    context.addIssue({ code: "custom", message: "active goal mismatch", input: run })
  }
}

const ulwLoopRunSchema = z
  .object({
    schemaVersion: z.literal(1),
    ...ulwLoopFields,
  })
  .strict()
  .superRefine(refineUlwLoop)
const ulwLoopRunV2Schema = z
  .object({ schemaVersion: z.literal(2), ...ulwLoopFields, ...v2EnvelopeFields })
  .strict()
  .superRefine(refineUlwLoop)

export const runSchema = z.union([
  startWorkRunSchema,
  startWorkRunV2Schema,
  ulwLoopRunSchema,
  ulwLoopRunV2Schema,
])
const activeIndexFields = {
  revision: counter,
  entries: z
    .array(
      z
        .object({
          workflow: z.enum(["start_work", "ulw_loop"]),
          sessionId: nonempty,
          runId: UuidSchema,
          ownerEpoch: counter,
          runRevision: counter,
          transactionRevision: counter,
          statusHint: z.enum(["active", "paused", "stuck", "blocked"]),
        })
        .strict(),
    )
    .readonly(),
} as const
export const activeIndexSchema = z.union([
  z
    .object({
      schemaVersion: z.literal(1),
      ...activeIndexFields,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(2),
      migrationRevision: counter.positive(),
      ...activeIndexFields,
    })
    .strict(),
])
const mutationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run_created"), run: runSchema }).strict(),
  z
    .object({
      kind: z.literal("workflow_controlled"),
      control: z.enum(["pause", "resume", "cancel"]),
    })
    .strict(),
  z.object({ kind: z.literal("owner_adopted"), sessionId: nonempty }).strict(),
  z
    .object({
      kind: z.literal("plan_reconciled"),
      taskIds: uniqueStrings,
      remainingTaskIds: uniqueStrings.optional(),
      taskFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("workflow_steered"),
      criteria: z
        .array(
          z
            .object({
              id: nonempty,
              scenario: nonempty,
              observable: nonempty,
              evidenceLogicalId: nonempty,
            })
            .strict(),
        )
        .min(1)
        .readonly(),
      annotation: z.string().max(512).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("criterion_settled"),
      goalId: nonempty,
      criterionId: nonempty,
      acceptanceId: nonempty.optional(),
      evidenceRef: nonempty,
      captureRevision: counter,
      captureCommit: nonempty,
    })
    .strict(),
  z
    .object({
      kind: z.literal("task_evidence_accepted"),
      taskId: nonempty,
      acceptanceId: nonempty,
    })
    .strict(),
  z
    .object({
      kind: z.literal("workflow_terminal"),
      status: z.enum(["completed", "failed"]),
      acceptanceIds: uniqueStrings.optional(),
      taskId: nonempty.optional(),
    })
    .strict()
    .superRefine((mutation, context) => {
      const completed = mutation.status === "completed"
      if (
        completed !== (mutation.acceptanceIds !== undefined) ||
        completed === (mutation.taskId !== undefined)
      ) {
        context.addIssue({ code: "custom", message: "terminal authority mismatch" })
      }
    }),
  z
    .object({
      kind: z.literal("continuation_attempted"),
      leafId: nonempty,
      progressRevision: counter,
    })
    .strict(),
  z.object({ kind: z.literal("continuation_stuck"), leafId: nonempty }).strict(),
  z.object({ kind: z.literal("goal_cycle_started"), goalId: nonempty }).strict(),
  z
    .object({
      kind: z.literal("criterion_failure_recorded"),
      goalId: nonempty,
      criterionId: nonempty,
      fingerprint: nonempty,
    })
    .strict(),
])
export const stateEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: UuidSchema,
    sequence: counter,
    runId: UuidSchema,
    workflow: z.enum(["start_work", "ulw_loop"]),
    kind: z.enum([
      "run_created",
      "workflow_controlled",
      "owner_adopted",
      "plan_reconciled",
      "workflow_steered",
      "criterion_settled",
      "task_evidence_accepted",
      "workflow_terminal",
      "continuation_attempted",
      "continuation_stuck",
      "goal_cycle_started",
      "criterion_failure_recorded",
    ]),
    expected: z
      .object({
        indexRevision: counter,
        runRevision: counter.nullable(),
        ownerSessionId: nonempty.nullable(),
        ownerEpoch: counter.nullable(),
      })
      .strict(),
    mutation: mutationSchema,
    at: timestamp,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.kind !== event.mutation.kind) {
      context.addIssue({ code: "custom", message: "event mutation mismatch" })
    }
  })

export const stateEventV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    eventId: UuidSchema,
    sequence: counter,
    runId: UuidSchema,
    workflow: z.enum(["start_work", "ulw_loop"]),
    kind: z.enum([
      "run_created",
      "workflow_controlled",
      "owner_adopted",
      "plan_reconciled",
      "workflow_steered",
      "criterion_settled",
      "task_evidence_accepted",
      "workflow_terminal",
      "continuation_attempted",
      "continuation_stuck",
      "goal_cycle_started",
      "criterion_failure_recorded",
    ]),
    expected: z
      .object({
        indexRevision: counter,
        runRevision: counter.nullable(),
        ownerSessionId: nonempty.nullable(),
        ownerEpoch: counter.nullable(),
        expectedHead: nonempty.nullable(),
        taskGeneration: counter.positive().nullable(),
      })
      .strict(),
    mutation: mutationSchema,
    legacyHeadUnbound: z.boolean(),
    at: timestamp,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.kind !== event.mutation.kind) {
      context.addIssue({ code: "custom", message: "event mutation mismatch" })
    }
    if (event.legacyHeadUnbound && event.expected.expectedHead !== null) {
      context.addIssue({ code: "custom", message: "legacy event cannot bind a head" })
    }
  })
