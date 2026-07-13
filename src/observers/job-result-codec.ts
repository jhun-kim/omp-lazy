import { z } from "zod"
import { AgentIdSchema, JobIdSchema } from "../contracts/agent-ids"

const jobSchema = z
  .object({
    id: JobIdSchema,
    type: z.enum(["bash", "task"]),
    status: z.enum(["running", "completed", "failed", "cancelled"]),
    label: z.string(),
    durationMs: z.number().nonnegative(),
    resultText: z.string().optional(),
    errorText: z.string().optional(),
  })
  .strict()

const jobResultSchema = z
  .object({
    jobs: z.array(jobSchema),
    cancelled: z
      .array(
        z
          .object({
            id: JobIdSchema,
            status: z.enum(["cancelled", "not_found", "already_completed"]),
          })
          .strict(),
      )
      .optional(),
    agents: z
      .array(
        z
          .object({
            id: AgentIdSchema,
            parentId: AgentIdSchema.optional(),
            activity: z.string().optional(),
            ageMs: z.number().nonnegative(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()

export type JobResultDetails = z.infer<typeof jobResultSchema>

export type JobResultDecode =
  | { readonly ok: true; readonly value: JobResultDetails }
  | { readonly ok: false; readonly code: "malformed_omp_16_4_8_job_result" }

export function decodeJobResult(details: unknown): JobResultDecode {
  const parsed = jobResultSchema.safeParse(details)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, code: "malformed_omp_16_4_8_job_result" }
}
