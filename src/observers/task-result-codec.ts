import { z } from "zod"
import { AgentIdSchema, JobIdSchema } from "../contracts/agent-ids"

const progressSchema = z
  .object({
    index: z.number().int().nonnegative(),
    id: AgentIdSchema,
    agent: z.string().trim().min(1),
    status: z.enum(["pending", "running", "completed", "failed", "aborted"]),
  })
  .passthrough()

const taskResultSchema = z
  .object({
    projectAgentsDir: z.string().nullable(),
    results: z.array(z.unknown()),
    totalDurationMs: z.number().nonnegative(),
    progress: z.array(progressSchema).optional(),
    async: z
      .object({
        state: z.enum(["running", "completed", "failed"]),
        jobId: JobIdSchema,
        type: z.literal("task"),
      })
      .strict()
      .optional(),
  })
  .passthrough()

export type TaskResultDetails = z.infer<typeof taskResultSchema>

export type TaskResultDecode =
  | { readonly ok: true; readonly value: TaskResultDetails }
  | { readonly ok: false; readonly code: "malformed_omp_16_4_8_task_result" }

export function decodeTaskResult(details: unknown): TaskResultDecode {
  const parsed = taskResultSchema.safeParse(details)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, code: "malformed_omp_16_4_8_task_result" }
}
