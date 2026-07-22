import { z } from "zod"
import { QualityScoreSchema } from "./quality-score"
import type { CompiledTaskPacket } from "./task-packet"
import { sameStringSet, sortedStrings, sortedUniqueStrings } from "./task-packet-canonical"

const hash = z.string().regex(/^[0-9a-f]{64}$/)
const head = z.string().regex(/^[0-9a-f]{40}$/)
const identifier = z.string().trim().min(1).max(160)
const identifiers = z.array(identifier).max(32)

export const CriticVerdictSchema = z.enum(["APPROVE", "BLOCKED"])
export type CriticVerdict = z.infer<typeof CriticVerdictSchema>

const hardGateSchema = z
  .object({
    id: identifier,
    passed: z.boolean(),
  })
  .strict()

export const CriticReceiptSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("omp_lazy_critic_receipt"),
    verdict: CriticVerdictSchema,
    actor: identifier,
    packetHash: hash,
    head,
    generation: z.number().int().positive(),
    receiptId: identifier,
    hardGates: z.array(hardGateSchema).min(1).max(32).readonly(),
    evidenceLogicalIds: identifiers.readonly(),
    qualityScore: QualityScoreSchema.optional(),
  })
  .strict()
  .superRefine((receipt, context) => {
    const hardGateIds = receipt.hardGates.map((gate) => gate.id)
    if (!sortedUniqueStrings(hardGateIds) || !sortedUniqueStrings(receipt.evidenceLogicalIds)) {
      context.addIssue({ code: "custom", message: "critic identifiers must be sorted and unique" })
    }
  })
export type CriticReceipt = z.infer<typeof CriticReceiptSchema>

export const CriticReceiptBindingSchema = z
  .object({
    actor: identifier,
    packetHash: hash,
    head,
    generation: z.number().int().positive(),
    receiptId: identifier,
    requiredHardGateIds: identifiers.min(1).readonly(),
    requiredEvidenceLogicalIds: identifiers.readonly(),
  })
  .strict()
  .superRefine((binding, context) => {
    if (
      !sortedUniqueStrings(binding.requiredHardGateIds) ||
      !sortedUniqueStrings(binding.requiredEvidenceLogicalIds)
    ) {
      context.addIssue({
        code: "custom",
        message: "required critic identifiers must be sorted and unique",
      })
    }
  })
export type CriticReceiptBinding = z.infer<typeof CriticReceiptBindingSchema>

export type CriticReceiptBindingIssue = {
  readonly actor: string
  readonly head: string
  readonly receiptId: string
  readonly packet: CompiledTaskPacket
}

export type CriticReceiptValidation =
  | { readonly ok: true; readonly receipt: CriticReceipt }
  | {
      readonly ok: false
      readonly code:
        | "malformed_critic_receipt"
        | "wrong_critic_actor"
        | "stale_packet"
        | "wrong_head"
        | "wrong_generation"
        | "wrong_receipt"
        | "required_hard_gates_mismatch"
        | "required_evidence_mismatch"
        | "hard_gate_failed"
        | "critic_blocked"
    }

export function bindCriticReceiptToPacket(issue: CriticReceiptBindingIssue): CriticReceiptBinding {
  return CriticReceiptBindingSchema.parse({
    actor: issue.actor,
    packetHash: issue.packet.packetHash,
    head: issue.head,
    generation: issue.packet.packet.generation,
    receiptId: issue.receiptId,
    requiredHardGateIds: sortedStrings(
      issue.packet.packet.criteria.map((criterion) => criterion.id),
    ),
    requiredEvidenceLogicalIds: sortedStrings(
      issue.packet.packet.evidenceRequirements
        .filter((requirement) => requirement.required)
        .map((requirement) => requirement.logicalId),
    ),
  })
}

export function validateCriticReceipt(
  expectedValue: unknown,
  receiptValue: unknown,
): CriticReceiptValidation {
  const expected = CriticReceiptBindingSchema.safeParse(expectedValue)
  const receipt = CriticReceiptSchema.safeParse(receiptValue)
  if (!expected.success || !receipt.success) return { ok: false, code: "malformed_critic_receipt" }
  if (receipt.data.actor !== expected.data.actor) return { ok: false, code: "wrong_critic_actor" }
  if (receipt.data.packetHash !== expected.data.packetHash)
    return { ok: false, code: "stale_packet" }
  if (receipt.data.head !== expected.data.head) return { ok: false, code: "wrong_head" }
  if (receipt.data.generation !== expected.data.generation)
    return { ok: false, code: "wrong_generation" }
  if (receipt.data.receiptId !== expected.data.receiptId)
    return { ok: false, code: "wrong_receipt" }
  if (
    !sameStringSet(
      receipt.data.hardGates.map((gate) => gate.id),
      expected.data.requiredHardGateIds,
    )
  ) {
    return { ok: false, code: "required_hard_gates_mismatch" }
  }
  if (!sameStringSet(receipt.data.evidenceLogicalIds, expected.data.requiredEvidenceLogicalIds)) {
    return { ok: false, code: "required_evidence_mismatch" }
  }
  if (
    receipt.data.hardGates.some((gate) => !gate.passed) ||
    receipt.data.qualityScore?.hardGatePassed === false
  ) {
    return { ok: false, code: "hard_gate_failed" }
  }
  if (receipt.data.verdict !== "APPROVE") return { ok: false, code: "critic_blocked" }
  return { ok: true, receipt: receipt.data }
}
