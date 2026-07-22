import { isAbsolute, posix } from "node:path"
import { z } from "zod"
import { BoundaryTagSchema, type TaskTier, TierBudgets } from "../contracts/task-packet"

const canonicalPath = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .superRefine((value, context) => {
    const normalized = value.replaceAll("\\", "/")
    if (
      value !== normalized ||
      isAbsolute(value) ||
      normalized.startsWith("/") ||
      normalized.split("/").includes("..") ||
      (normalized !== "." && posix.normalize(normalized) !== normalized)
    ) {
      context.addIssue({
        code: "custom",
        message: "path must be canonical and repository-relative",
      })
    }
  })

const classifierInputSchema = z
  .object({
    allowedPaths: z.array(canonicalPath).max(64).readonly(),
    moduleRoots: z.array(canonicalPath).max(64).readonly(),
    boundaryTags: z.array(BoundaryTagSchema).min(1).max(8).readonly(),
    explicitReview: z.boolean(),
    mutating: z.boolean(),
    publicBehavior: z.boolean(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      new Set(input.allowedPaths).size !== input.allowedPaths.length ||
      new Set(input.moduleRoots).size !== input.moduleRoots.length
    ) {
      context.addIssue({ code: "custom", message: "classifier paths must be unique" })
    }
    if (input.allowedPaths.length === 0 && input.moduleRoots.length > 0) {
      context.addIssue({ code: "custom", message: "zero-file work cannot have module roots" })
    }
    if (input.boundaryTags.includes("none") && input.boundaryTags.length !== 1) {
      context.addIssue({ code: "custom", message: "none boundary tag is exclusive" })
    }
  })

type CriticPolicy = "none" | "after_deterministic_failure" | "required"
type TierCeiling = (typeof TierBudgets)[TaskTier] & {
  readonly maxActivePackets: number
  readonly maxSemanticRolesPerPacket: number
  readonly criticPolicy: CriticPolicy
}

export const RiskTierCeilings = {
  FAST: {
    ...TierBudgets.FAST,
    maxActivePackets: 1,
    maxSemanticRolesPerPacket: 1,
    criticPolicy: "none",
  },
  STANDARD: {
    ...TierBudgets.STANDARD,
    maxActivePackets: 2,
    maxSemanticRolesPerPacket: 2,
    criticPolicy: "after_deterministic_failure",
  },
  DEEP: {
    ...TierBudgets.DEEP,
    maxActivePackets: 4,
    maxSemanticRolesPerPacket: 3,
    criticPolicy: "required",
  },
} as const satisfies Record<TaskTier, TierCeiling>

type RiskReason =
  | "concrete_boundary"
  | "explicit_review"
  | "file_count"
  | "unknown_boundary"
  | "module_count"
  | "public_behavior"
  | "unknown_mutation_path"
  | "bounded_local"

type RiskFeatures = {
  readonly fileCount: number
  readonly moduleCount: number
  readonly boundaryTags: readonly z.infer<typeof BoundaryTagSchema>[]
  readonly explicitReview: boolean
  readonly mutating: boolean
  readonly publicBehavior: boolean
}

export type RiskClassificationReceipt =
  | {
      readonly schemaVersion: 1
      readonly status: "PASS"
      readonly tier: TaskTier
      readonly reason: RiskReason
      readonly features: RiskFeatures
      readonly ceilings: TierCeiling
    }
  | {
      readonly schemaVersion: 1
      readonly status: "BLOCKED"
      readonly code: "invalid_classifier_input"
    }

function orderedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

export function classifyWorkflowRisk(input: unknown): RiskClassificationReceipt {
  const parsed = classifierInputSchema.safeParse(input)
  if (!parsed.success) {
    return { schemaVersion: 1, status: "BLOCKED", code: "invalid_classifier_input" }
  }
  const concreteTags = parsed.data.boundaryTags.filter((tag) => tag !== "none" && tag !== "unknown")
  const boundaryTags = orderedUnique(
    concreteTags.length > 0 ? concreteTags : parsed.data.boundaryTags,
  ) as readonly z.infer<typeof BoundaryTagSchema>[]
  const features = {
    fileCount: parsed.data.allowedPaths.length,
    moduleCount: parsed.data.moduleRoots.length,
    boundaryTags,
    explicitReview: parsed.data.explicitReview,
    mutating: parsed.data.mutating,
    publicBehavior: parsed.data.publicBehavior,
  }
  let tier: TaskTier
  let reason: RiskReason
  if (concreteTags.length > 0) {
    tier = "DEEP"
    reason = "concrete_boundary"
  } else if (parsed.data.explicitReview) {
    tier = "DEEP"
    reason = "explicit_review"
  } else if (features.fileCount > 8) {
    tier = "DEEP"
    reason = "file_count"
  } else if (boundaryTags.includes("unknown")) {
    tier = "STANDARD"
    reason = "unknown_boundary"
  } else if (features.fileCount >= 3) {
    tier = "STANDARD"
    reason = "file_count"
  } else if (features.moduleCount > 1) {
    tier = "STANDARD"
    reason = "module_count"
  } else if (features.publicBehavior) {
    tier = "STANDARD"
    reason = "public_behavior"
  } else if (features.mutating && features.fileCount === 0) {
    tier = "STANDARD"
    reason = "unknown_mutation_path"
  } else {
    tier = "FAST"
    reason = "bounded_local"
  }
  return {
    schemaVersion: 1,
    status: "PASS",
    tier,
    reason,
    features,
    ceilings: RiskTierCeilings[tier],
  }
}
