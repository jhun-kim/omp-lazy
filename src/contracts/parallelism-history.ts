import { z } from "zod"

const canonicalPath = z
  .string()
  .min(1)
  .max(512)
  .regex(/^(?:\.|[A-Za-z0-9][A-Za-z0-9._/-]*)$/)
  .superRefine((path, context) => {
    if (path.includes("\\") || path.split("/").includes("..") || path.includes("//")) {
      context.addIssue({ code: "custom", message: "bucket path must be canonical" })
    }
  })

export const ParallelismHistoryKeySchema = z
  .object({
    moduleBuckets: z.array(canonicalPath).min(1).max(32).readonly(),
    fileBuckets: z.array(canonicalPath).min(1).max(128).readonly(),
  })
  .strict()
  .superRefine((key, context) => {
    const buckets = [key.moduleBuckets, key.fileBuckets]
    if (
      buckets.some(
        (values) =>
          new Set(values).size !== values.length ||
          values.some((value, index) => index > 0 && values[index - 1]?.localeCompare(value) === 1),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "parallelism key buckets must be sorted and unique",
      })
    }
  })
export type ParallelismHistoryKey = z.infer<typeof ParallelismHistoryKeySchema>

export const ParallelismHistorySampleSchema = z
  .object({
    status: z.enum(["PASS", "FAILED", "BLOCKED", "TIMEOUT"]),
    reservationConsumedAtMs: z.number().finite().nonnegative(),
    parentAcceptedAtMs: z.number().finite().nonnegative(),
    cleanupCompletedAtMs: z.number().finite().nonnegative(),
    startupCommittedAtMs: z.number().finite().nonnegative(),
    firstProviderRequestAtMs: z.number().finite().nonnegative(),
    executionMode: z.enum(["serial", "parallel"]),
  })
  .strict()
  .superRefine((sample, context) => {
    if (
      sample.reservationConsumedAtMs > sample.parentAcceptedAtMs ||
      sample.parentAcceptedAtMs > sample.cleanupCompletedAtMs ||
      sample.startupCommittedAtMs > sample.firstProviderRequestAtMs
    ) {
      context.addIssue({ code: "custom", message: "history timestamps must be monotonic" })
    }
  })
export type ParallelismHistorySample = z.infer<typeof ParallelismHistorySampleSchema>

export const ParallelismHistorySchema = z
  .object({
    version: z.literal(1),
    key: ParallelismHistoryKeySchema,
    samples: z.array(ParallelismHistorySampleSchema).max(500).readonly(),
  })
  .strict()
export type ParallelismHistory = z.infer<typeof ParallelismHistorySchema>

export type ParallelismHistorySummary =
  | {
      readonly eligibleCount: number
      readonly durationMedianMs: number
      readonly durationP95Ms: number
      readonly startupMedianMs: number
      readonly startupP95Ms: number
    }
  | { readonly eligibleCount: number; readonly code: "parallelism_history_insufficient" }

function median(values: readonly number[]): number {
  const lowerIndex = Math.floor((values.length - 1) / 2)
  const upperIndex = Math.ceil((values.length - 1) / 2)
  return (
    values.reduce(
      (total, value, index) =>
        index === lowerIndex || index === upperIndex ? total + value : total,
      0,
    ) / (lowerIndex === upperIndex ? 1 : 2)
  )
}

function nearestRankP95(values: readonly number[]): number {
  const rank = Math.ceil(values.length * 0.95) - 1
  return values.reduce((result, value, index) => (index === rank ? value : result), 0)
}

export function summarizeParallelismHistory(value: unknown): ParallelismHistorySummary {
  const history = ParallelismHistorySchema.parse(value)
  const eligible = history.samples.filter((sample) => sample.status === "PASS").slice(-50)
  if (eligible.length < 5)
    return { eligibleCount: eligible.length, code: "parallelism_history_insufficient" }
  const durations = eligible
    .map((sample) => sample.cleanupCompletedAtMs - sample.reservationConsumedAtMs)
    .sort((left, right) => left - right)
  const startups = eligible
    .map((sample) => sample.firstProviderRequestAtMs - sample.startupCommittedAtMs)
    .sort((left, right) => left - right)
  return {
    eligibleCount: eligible.length,
    durationMedianMs: median(durations),
    durationP95Ms: nearestRankP95(durations),
    startupMedianMs: median(startups),
    startupP95Ms: nearestRankP95(startups),
  }
}
