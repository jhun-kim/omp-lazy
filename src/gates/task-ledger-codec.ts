import { z } from "zod"
import {
  AgentIdSchema,
  JobIdSchema,
  RuntimeIdentityBindingSchema,
  ToolCallIdSchema,
} from "../contracts/agent-ids"
import { UuidSchema } from "../state/domain"

const counter = z.number().int().nonnegative()
const nonempty = z.string().trim().min(1)
const requestSchema = z
  .object({
    canonicalInputHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    itemIndex: counter,
    requestedName: nonempty.nullable(),
    agentType: nonempty.nullable(),
  })
  .strict()

const receiptSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("job"),
      jobId: JobIdSchema,
      status: z.enum(["running", "completed", "failed", "cancelled"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("job_cancel"),
      jobId: JobIdSchema,
      status: z.literal("cancelled"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("irc"),
      agentId: AgentIdSchema,
      outcome: z.enum(["injected", "woken", "revived", "failed"]),
    })
    .strict(),
])

const factSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("task_reserved"),
      toolCallId: ToolCallIdSchema,
      itemCount: counter.positive(),
      requests: z.array(requestSchema).min(1).readonly(),
    })
    .strict()
    .superRefine((fact, context) => {
      if (
        fact.itemCount !== fact.requests.length ||
        fact.requests.some((request, position) => request.itemIndex !== position)
      ) {
        context.addIssue({ code: "custom", message: "reservation item mismatch" })
      }
    }),
  z
    .object({
      kind: z.literal("task_identities_bound"),
      toolCallId: ToolCallIdSchema,
      bindings: z.array(RuntimeIdentityBindingSchema).min(1).readonly(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("task_control_authorized"),
      toolCallId: ToolCallIdSchema,
      control: z.enum(["job_snapshot", "job_cancel", "irc_send", "irc_target"]),
      taskGeneration: counter.positive(),
      inputKey: nonempty,
      targets: z.array(nonempty).readonly(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("task_receipt_observed"),
      toolCallId: ToolCallIdSchema,
      receipt: receiptSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("async_capability_observed"),
      toolCallId: ToolCallIdSchema,
      taskGeneration: counter.positive(),
      status: z.enum(["proven", "blocked"]),
      reason: nonempty,
    })
    .strict(),
])

export type TaskFact = z.infer<typeof factSchema>
export type TaskReservationFact = Extract<TaskFact, { readonly kind: "task_reserved" }>
export type TaskIdentityFact = Extract<TaskFact, { readonly kind: "task_identities_bound" }>
export type TaskAuthorizationFact = Extract<TaskFact, { readonly kind: "task_control_authorized" }>
export type TaskReceiptFact = Extract<TaskFact, { readonly kind: "task_receipt_observed" }>

const taskLedgerFields = {
  runId: UuidSchema,
  ledgerRevision: counter,
  entries: z
    .array(
      z
        .object({
          sequence: counter.positive(),
          ownerSessionId: nonempty,
          ownerEpoch: counter,
          fact: factSchema,
        })
        .strict(),
    )
    .readonly(),
} as const

function ledgerIsOrdered(ledger: {
  readonly ledgerRevision: number
  readonly entries: readonly {
    readonly sequence: number
    readonly ownerSessionId: string
    readonly ownerEpoch: number
    readonly fact: TaskFact
  }[]
}): boolean {
  if (
    ledger.ledgerRevision !== ledger.entries.length ||
    ledger.entries.some((entry, position) => entry.sequence !== position + 1)
  ) {
    return false
  }
  const keys = ledger.entries.map(
    (entry) => `${entry.ownerSessionId}\u0000${entry.ownerEpoch}\u0000${taskFactKey(entry.fact)}`,
  )
  return new Set(keys).size === keys.length
}

export const taskLedgerSchema = z
  .object({
    schemaVersion: z.literal(1),
    ...taskLedgerFields,
  })
  .strict()
  .superRefine((ledger, context) => {
    if (!ledgerIsOrdered(ledger)) {
      context.addIssue({ code: "custom", message: "duplicate task fact key" })
    }
  })

export const taskLedgerV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    ...taskLedgerFields,
    packetHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    tier: z.enum(["FAST", "STANDARD", "DEEP"]).nullable(),
    reservationId: nonempty.nullable(),
  })
  .strict()
  .superRefine((ledger, context) => {
    if (!ledgerIsOrdered(ledger)) {
      context.addIssue({ code: "custom", message: "duplicate task fact key" })
    }
  })

export type TaskLedger = z.infer<typeof taskLedgerSchema>
export type TaskLedgerV2 = z.infer<typeof taskLedgerV2Schema>
export type PersistedTaskLedger = TaskLedger | TaskLedgerV2
export type TaskLedgerEntry = TaskLedger["entries"][number]

export function taskFactKey(fact: TaskFact): string {
  if (fact.kind === "task_receipt_observed") {
    const target = fact.receipt.kind === "irc" ? fact.receipt.agentId : fact.receipt.jobId
    return `${fact.kind}\u0000${fact.toolCallId}\u0000${fact.receipt.kind}\u0000${target}`
  }
  return `${fact.kind}\u0000${fact.toolCallId}`
}
