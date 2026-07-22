import { isAbsolute, posix } from "node:path"
import { z } from "zod"
import { BoundaryTagSchema, TaskTierSchema } from "./task-packet"
import { sortedUniqueStrings } from "./task-packet-canonical"

const canonicalPath = z
  .string()
  .min(1)
  .max(512)
  .regex(/^(?:\.|[A-Za-z0-9][A-Za-z0-9._/-]*)$/)
  .superRefine((path, context) => {
    const normalized = path.replaceAll("\\", "/")
    if (
      path !== normalized ||
      isAbsolute(path) ||
      normalized.startsWith("/") ||
      normalized.split("/").includes("..") ||
      posix.normalize(normalized) !== normalized ||
      (normalized !== "." && (normalized.startsWith("./") || normalized.endsWith("/")))
    ) {
      context.addIssue({ code: "custom", message: "bucket path must be canonical" })
    }
  })

export const ParallelismHistoryKeySchema = z
  .object({
    executionMode: z.enum(["serial", "parallel"]),
    tier: TaskTierSchema,
    moduleCount: z.number().int().positive().max(64),
    fileBucket: canonicalPath,
    boundaryTags: z.array(BoundaryTagSchema).min(1).max(8).readonly(),
  })
  .strict()
  .superRefine((key, context) => {
    if (!sortedUniqueStrings(key.boundaryTags)) {
      context.addIssue({
        code: "custom",
        message: "parallelism boundary tags must be sorted and unique",
      })
    }
    if (key.boundaryTags.includes("none") && key.boundaryTags.length !== 1) {
      context.addIssue({ code: "custom", message: "none boundary tag is exclusive" })
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

export type ParallelismStatistic =
  | { readonly eligibleCount: number; readonly medianMs: number; readonly p95Ms: number }
  | { readonly eligibleCount: number; readonly code: "parallelism_history_insufficient" }

export type ParallelismHistorySummary = {
  readonly eligibleCount: number
  readonly serialDuration: ParallelismStatistic
  readonly startup: ParallelismStatistic
}

function median(values: readonly number[]): number {
  const lowerIndex = Math.floor((values.length - 1) / 2)
  const upperIndex = Math.ceil((values.length - 1) / 2)
  const lower = values[lowerIndex]
  const upper = values[upperIndex]
  if (lower === undefined || upper === undefined) throw new RangeError("median requires values")
  return (lower + upper) / 2
}

function nearestRankP95(values: readonly number[]): number {
  const value = values[Math.ceil(values.length * 0.95) - 1]
  if (value === undefined) throw new RangeError("p95 requires values")
  return value
}

function summarizeStatistic(values: readonly number[]): ParallelismStatistic {
  if (values.length < 5) {
    return { eligibleCount: values.length, code: "parallelism_history_insufficient" }
  }
  const sorted = [...values].sort((left, right) => left - right)
  return { eligibleCount: sorted.length, medianMs: median(sorted), p95Ms: nearestRankP95(sorted) }
}

export function summarizeParallelismHistory(value: unknown): ParallelismHistorySummary {
  const history = ParallelismHistorySchema.parse(value)
  const eligible = history.samples.filter((sample) => sample.status === "PASS").slice(-50)
  const serialDurations =
    history.key.executionMode === "serial"
      ? eligible.map((sample) => sample.cleanupCompletedAtMs - sample.reservationConsumedAtMs)
      : []
  const startups = eligible.map(
    (sample) => sample.firstProviderRequestAtMs - sample.startupCommittedAtMs,
  )
  return {
    eligibleCount: eligible.length,
    serialDuration: summarizeStatistic(serialDurations),
    startup: summarizeStatistic(startups),
  }
}
