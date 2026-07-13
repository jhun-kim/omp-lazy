import { z } from "zod"
import { UuidSchema } from "../state/domain"
import { AgentIdSchema, JobIdSchema } from "./agent-ids"

const counter = z.number().int().nonnegative()
const nonempty = z.string().trim().min(1).max(1_024)
const commit = z.string().regex(/^[0-9a-f]{40}$/)

export const WorkerRoleSchema = z.enum([
  "omp-lazy-worker-low",
  "omp-lazy-worker-medium",
  "omp-lazy-worker-high",
])
export type WorkerRole = z.infer<typeof WorkerRoleSchema>

const captureSchema = z
  .object({
    runId: UuidSchema,
    attempt: counter,
    commit,
  })
  .strict()

export const EvidenceArtifactClaimSchema = z
  .object({
    path: nonempty,
    capture: captureSchema,
  })
  .strict()

export const CleanupReceiptClaimSchema = z
  .object({
    resourceId: nonempty,
    receiptPath: nonempty,
  })
  .strict()

export const WorkerEvidenceReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("omp_lazy_worker_evidence"),
    runId: UuidSchema,
    attempt: counter,
    runRevision: counter,
    ownerEpoch: counter,
    taskGeneration: counter.positive(),
    workerRole: WorkerRoleSchema,
    actualAgentId: AgentIdSchema,
    actualJobId: JobIdSchema.nullable(),
    captureCommit: commit,
    output: z
      .object({
        exitCode: z.number().int(),
        truncated: z.boolean(),
        schemaOverridden: z.boolean(),
        aborted: z.boolean(),
        blocked: z.boolean(),
      })
      .strict(),
    artifacts: z.array(EvidenceArtifactClaimSchema).min(1).max(32).readonly(),
    cleanup: z.array(CleanupReceiptClaimSchema).min(1).max(32).readonly(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      new Set(receipt.artifacts.map((artifact) => artifact.path)).size !==
        receipt.artifacts.length ||
      new Set(receipt.cleanup.map((cleanup) => cleanup.resourceId)).size !==
        receipt.cleanup.length ||
      new Set(receipt.cleanup.map((cleanup) => cleanup.receiptPath)).size !== receipt.cleanup.length
    ) {
      context.addIssue({ code: "custom", message: "duplicate evidence claim" })
    }
  })

export type WorkerEvidenceReceipt = z.infer<typeof WorkerEvidenceReceiptSchema>

export const CleanupReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("omp_lazy_cleanup"),
    runId: UuidSchema,
    attempt: counter,
    actualAgentId: AgentIdSchema,
    resourceId: nonempty,
    status: z.literal("cleaned"),
    captureCommit: commit,
  })
  .strict()

export type CleanupReceipt = z.infer<typeof CleanupReceiptSchema>

export const WorkerAcceptanceInputSchema = z
  .object({
    agentId: AgentIdSchema,
    receiptPath: nonempty,
    parentDecision: z.enum(["accept_after_review", "retry_worker", "cancel_dispatch"]).optional(),
  })
  .strict()

export type WorkerAcceptanceInput = z.infer<typeof WorkerAcceptanceInputSchema>
