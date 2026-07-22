import { z } from "zod"
import { UuidSchema } from "../state/domain"
import { AgentIdSchema, JobIdSchema } from "./agent-ids"

const counter = z.number().int().nonnegative()
const nonempty = z.string().trim().min(1).max(1_024)
const commit = z.string().regex(/^[0-9a-f]{40}$/)
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const artifactHashes = z
  .array(hash)
  .min(1)
  .max(32)
  .readonly()
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: "duplicate artifact hash" })
    }
  })

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

export const ResourceEvidenceSchema = z
  .object({
    resourceId: nonempty,
    kind: z.enum(["tool", "process", "worktree", "resource"]),
  })
  .strict()

const cleanupReceiptClaims = z.array(CleanupReceiptClaimSchema).min(1).max(32).readonly()

export const CleanupEvidenceSchema = z.union([
  cleanupReceiptClaims,
  z.discriminatedUnion("status", [
    z
      .object({
        status: z.literal("receipts"),
        claims: cleanupReceiptClaims,
      })
      .strict(),
    z
      .object({
        status: z.literal("not_applicable"),
        declaration: z
          .object({
            scenarioId: nonempty,
            resourceKinds: z.tuple([]),
          })
          .strict(),
      })
      .strict(),
  ]),
])
export type CleanupEvidence = z.infer<typeof CleanupEvidenceSchema>

export function isLegacyCleanupEvidence(
  value: CleanupEvidence,
): value is readonly z.infer<typeof CleanupReceiptClaimSchema>[] {
  return Array.isArray(value)
}

export function cleanupClaimsForEvidence(
  value: CleanupEvidence,
): readonly z.infer<typeof CleanupReceiptClaimSchema>[] {
  if (isLegacyCleanupEvidence(value)) return value
  switch (value.status) {
    case "receipts":
      return value.claims
    case "not_applicable":
      return []
    default:
      return value satisfies never
  }
}

export const CompactWorkerOutputSchema = z
  .object({
    status: z.enum(["PASS", "BLOCKED"]),
    receiptId: hash,
    artifactHashes,
  })
  .strict()

export const CompactCriticOutputSchema = z
  .object({
    verdict: z.enum(["APPROVE", "BLOCKED"]),
    receiptId: hash,
    artifactHashes,
  })
  .strict()

export const CompactQaOutputSchema = z
  .object({
    status: z.enum(["PASS", "BLOCKED"]),
    receiptId: hash,
    scenarioIds: z.array(nonempty).min(1).max(32).readonly(),
    artifactHashes,
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
    resources: z.array(ResourceEvidenceSchema).max(32).readonly().default([]),
    cleanup: CleanupEvidenceSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    const typedCleanup = isLegacyCleanupEvidence(receipt.cleanup) ? null : receipt.cleanup
    const cleanupClaims = cleanupClaimsForEvidence(receipt.cleanup)
    if (
      new Set(receipt.artifacts.map((artifact) => artifact.path)).size !==
        receipt.artifacts.length ||
      new Set(receipt.resources.map((resource) => resource.resourceId)).size !==
        receipt.resources.length ||
      new Set(cleanupClaims.map((cleanup) => cleanup.resourceId)).size !== cleanupClaims.length ||
      new Set(cleanupClaims.map((cleanup) => cleanup.receiptPath)).size !== cleanupClaims.length
    ) {
      context.addIssue({ code: "custom", message: "duplicate evidence claim" })
    }
    if (
      typedCleanup?.status === "receipts" &&
      (receipt.resources.length !== typedCleanup.claims.length ||
        receipt.resources.some(
          (resource) =>
            !typedCleanup.claims.some((claim) => claim.resourceId === resource.resourceId),
        ))
    ) {
      context.addIssue({ code: "custom", message: "resource cleanup receipt mismatch" })
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
