import { z } from "zod"

export const WorkflowCommandResultSchema = z.strictObject({
  schemaVersion: z.literal(2),
  status: z.enum(["PASS", "BLOCKED"]),
  workflow: z.string().min(1),
  operation: z.string().min(1),
  runId: z.string().min(1).nullable(),
  revision: z.number().int().nonnegative().nullable(),
  runStatus: z.string().min(1).nullable(),
  code: z.string().min(1).nullable(),
})

export type WorkflowCommandResult = z.infer<typeof WorkflowCommandResultSchema>

export function commandResult(
  value: Omit<WorkflowCommandResult, "schemaVersion">,
): WorkflowCommandResult {
  return WorkflowCommandResultSchema.parse({ schemaVersion: 2, ...value })
}
