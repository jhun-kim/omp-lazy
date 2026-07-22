import { createHash } from "node:crypto"
import { isAbsolute, posix } from "node:path"
import { z } from "zod"
import {
  canonicalJson,
  compareOrdinalStrings,
  normalizeNfc,
  sameStringSet,
  sortedStrings,
  sortedUniqueStrings,
} from "./task-packet-canonical"

const nonempty = z.string().trim().min(1).max(1_024)
const packetText = z
  .string()
  .trim()
  .min(1)
  .max(12 * 1024)
const identifier = z.string().trim().min(1).max(160)
const canonicalPath = z
  .string()
  .min(1)
  .max(512)
  .superRefine((value, context) => {
    const normalized = value.replaceAll("\\", "/")
    if (
      value !== normalized ||
      isAbsolute(value) ||
      normalized.startsWith("/") ||
      normalized.split("/").includes("..") ||
      posix.normalize(normalized) !== normalized
    ) {
      context.addIssue({
        code: "custom",
        message: "path must be canonical and repository-relative",
      })
    }
  })

export const TaskTierSchema = z.enum(["FAST", "STANDARD", "DEEP"])
export type TaskTier = z.infer<typeof TaskTierSchema>

export const TierBudgetSchema = z
  .object({
    maxCalls: z.number().int().positive(),
    maxPacketBytes: z.number().int().positive(),
    maxRetrievalCalls: z.number().int().nonnegative(),
    maxRetrievalBytes: z.number().int().nonnegative(),
  })
  .strict()
export type TierBudget = z.infer<typeof TierBudgetSchema>

export const TierBudgets = {
  FAST: {
    maxCalls: 3,
    maxPacketBytes: 4 * 1024,
    maxRetrievalCalls: 4,
    maxRetrievalBytes: 16 * 1024,
  },
  STANDARD: {
    maxCalls: 11,
    maxPacketBytes: 8 * 1024,
    maxRetrievalCalls: 10,
    maxRetrievalBytes: 64 * 1024,
  },
  DEEP: {
    maxCalls: 28,
    maxPacketBytes: 12 * 1024,
    maxRetrievalCalls: 20,
    maxRetrievalBytes: 160 * 1024,
  },
} as const satisfies Record<TaskTier, TierBudget>

export const BoundaryTagSchema = z.enum([
  "none",
  "unknown",
  "authorization",
  "containment",
  "external_write",
  "network",
  "privacy",
  "security",
])
export type BoundaryTag = z.infer<typeof BoundaryTagSchema>

const criterionSchema = z
  .object({
    id: identifier,
    scenario: nonempty,
    observable: nonempty,
    expected: nonempty,
    evidenceLogicalId: identifier,
  })
  .strict()

const evidenceRequirementSchema = z
  .object({
    logicalId: identifier,
    kind: z.enum(["artifact", "test", "cleanup", "citation"]),
    required: z.boolean(),
  })
  .strict()

const taskPacketBaseSchema = z
  .object({
    version: z.literal(1),
    runId: identifier,
    taskId: identifier,
    generation: z.number().int().positive(),
    objective: packetText,
    deliverable: packetText,
    allowedPaths: z.array(canonicalPath).max(64).readonly(),
    referenceIds: z.array(identifier).max(64).readonly(),
    dependencyIds: z.array(identifier).max(32).readonly(),
    criteria: z.array(criterionSchema).min(1).max(6).readonly(),
    boundaryTags: z.array(BoundaryTagSchema).min(1).max(8).readonly(),
    publicBehavior: z.boolean(),
    tier: TaskTierSchema,
    budgets: TierBudgetSchema,
    evidenceRequirements: z.array(evidenceRequirementSchema).min(1).max(12).readonly(),
  })
  .strict()

export const TaskPacketSchema = taskPacketBaseSchema.superRefine((packet, context) => {
  const setArrays = [packet.allowedPaths, packet.referenceIds, packet.boundaryTags]
  if (setArrays.some((values) => new Set(values).size !== values.length)) {
    context.addIssue({ code: "custom", message: "packet set arrays must be unique" })
  }
  if (setArrays.some((values) => !sortedUniqueStrings(values))) {
    context.addIssue({ code: "custom", message: "packet set arrays must be sorted" })
  }
  if (
    new Set(packet.dependencyIds).size !== packet.dependencyIds.length ||
    new Set(packet.criteria.map((criterion) => criterion.id)).size !== packet.criteria.length ||
    new Set(packet.evidenceRequirements.map((requirement) => requirement.logicalId)).size !==
      packet.evidenceRequirements.length
  ) {
    context.addIssue({ code: "custom", message: "packet identifiers must be unique" })
  }
  if (packet.boundaryTags.includes("none") && packet.boundaryTags.length !== 1) {
    context.addIssue({ code: "custom", message: "none boundary tag is exclusive" })
  }
  if (
    !sameStringSet(
      packet.criteria.map((criterion) => criterion.evidenceLogicalId),
      packet.evidenceRequirements
        .filter((requirement) => requirement.required)
        .map((requirement) => requirement.logicalId),
    )
  ) {
    context.addIssue({ code: "custom", message: "criteria must cover required evidence" })
  }
  if (!tierMatchesBudget(packet.tier, packet.budgets)) {
    context.addIssue({ code: "custom", message: "tier budget mismatch" })
  }
  if (classifyTaskTier(packet) !== packet.tier) {
    context.addIssue({ code: "custom", message: "packet tier does not match canonical risk" })
  }
})

export type TaskPacket = z.infer<typeof TaskPacketSchema>

const taskPacketInputSchema = taskPacketBaseSchema.extend({
  boundaryTags: z.array(nonempty).min(1).max(8).readonly(),
})
export type TaskPacketInput = z.infer<typeof taskPacketInputSchema>

export type CompiledTaskPacket = {
  readonly packet: TaskPacket
  readonly canonicalJson: string
  readonly packetHash: string
  readonly packetBytes: number
}

export type TaskPacketCompileResult =
  | ({ readonly ok: true } & CompiledTaskPacket)
  | { readonly ok: false; readonly code: "malformed_packet" | "packet_budget_exceeded" }

function normalizeTag(value: string): BoundaryTag | null {
  const candidate = value.trim().toLowerCase().replaceAll("-", "_")
  const parsed = BoundaryTagSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

function tierMatchesBudget(tier: TaskTier, budget: TierBudget): boolean {
  const expected = TierBudgets[tier]
  return (
    budget.maxCalls === expected.maxCalls &&
    budget.maxPacketBytes === expected.maxPacketBytes &&
    budget.maxRetrievalCalls === expected.maxRetrievalCalls &&
    budget.maxRetrievalBytes === expected.maxRetrievalBytes
  )
}

export function classifyTaskTier(
  packet: Pick<TaskPacket, "allowedPaths" | "boundaryTags" | "publicBehavior">,
): TaskTier {
  if (
    packet.boundaryTags.some((tag) => tag !== "none" && tag !== "unknown") ||
    packet.allowedPaths.length > 8
  ) {
    return "DEEP"
  }
  if (
    packet.boundaryTags.includes("unknown") ||
    packet.allowedPaths.length >= 3 ||
    packet.publicBehavior
  ) {
    return "STANDARD"
  }
  return "FAST"
}

function canonicalPacket(input: TaskPacketInput): TaskPacket | null {
  const tags = input.boundaryTags.map(normalizeTag)
  const normalizedTags = tags.filter((tag): tag is BoundaryTag => tag !== null)
  if (normalizedTags.length !== tags.length) return null
  const concreteTags = normalizedTags.filter((tag) => tag !== "none" && tag !== "unknown")
  const boundaryTags =
    concreteTags.length > 0 ? sortedStrings(concreteTags) : sortedStrings(normalizedTags)
  const candidate = {
    ...input,
    runId: normalizeNfc(input.runId),
    taskId: normalizeNfc(input.taskId),
    objective: normalizeNfc(input.objective),
    deliverable: normalizeNfc(input.deliverable),
    allowedPaths: sortedStrings(input.allowedPaths.map(normalizeNfc)),
    referenceIds: sortedStrings(input.referenceIds.map(normalizeNfc)),
    dependencyIds: input.dependencyIds.map(normalizeNfc),
    criteria: input.criteria.map((criterion) => ({
      id: normalizeNfc(criterion.id),
      scenario: normalizeNfc(criterion.scenario),
      observable: normalizeNfc(criterion.observable),
      expected: normalizeNfc(criterion.expected),
      evidenceLogicalId: normalizeNfc(criterion.evidenceLogicalId),
    })),
    boundaryTags,
    evidenceRequirements: input.evidenceRequirements
      .map((requirement) => ({ ...requirement, logicalId: normalizeNfc(requirement.logicalId) }))
      .sort((left, right) => compareOrdinalStrings(left.logicalId, right.logicalId)),
  }
  const parsed = TaskPacketSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

export function compileTaskPacket(input: unknown): TaskPacketCompileResult {
  const parsed = taskPacketInputSchema.safeParse(input)
  if (!parsed.success) return { ok: false, code: "malformed_packet" }
  const packet = canonicalPacket(parsed.data)
  if (packet === null) return { ok: false, code: "malformed_packet" }
  const packetJson = canonicalJson(packet)
  const packetBytes = Buffer.byteLength(packetJson, "utf8")
  if (packetBytes > packet.budgets.maxPacketBytes)
    return { ok: false, code: "packet_budget_exceeded" }
  return {
    ok: true,
    packet,
    canonicalJson: packetJson,
    packetHash: createHash("sha256").update(packetJson, "utf8").digest("hex"),
    packetBytes,
  }
}
