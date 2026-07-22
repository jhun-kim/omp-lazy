import { z } from "zod"
import { QualityScoreSchema } from "./quality-score"

const hash = z.string().regex(/^[0-9a-f]{64}$/)
const head = z.string().regex(/^[0-9a-f]{40}$/)
const identifier = z.string().trim().min(1).max(160)

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
    qualityScore: QualityScoreSchema.optional(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (new Set(receipt.hardGates.map((gate) => gate.id)).size !== receipt.hardGates.length) {
      context.addIssue({ code: "custom", message: "hard gate identifiers must be unique" })
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
  })
  .strict()
export type CriticReceiptBinding = z.infer<typeof CriticReceiptBindingSchema>

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
        | "hard_gate_failed"
        | "critic_blocked"
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
    receipt.data.hardGates.some((gate) => !gate.passed) ||
    receipt.data.qualityScore?.hardGatePassed === false
  ) {
    return { ok: false, code: "hard_gate_failed" }
  }
  if (receipt.data.verdict !== "APPROVE") return { ok: false, code: "critic_blocked" }
  return { ok: true, receipt: receipt.data }
}
