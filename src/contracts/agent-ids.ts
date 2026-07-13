import { z } from "zod"

const runtimeId = z.string().trim().min(1).max(160)

export const ToolCallIdSchema = runtimeId.brand("ToolCallId")
export type ToolCallId = z.infer<typeof ToolCallIdSchema>

export const AgentIdSchema = runtimeId.brand("AgentId")
export type AgentId = z.infer<typeof AgentIdSchema>

export const JobIdSchema = runtimeId.brand("JobId")
export type JobId = z.infer<typeof JobIdSchema>

export function runtimeIdValue(id: AgentId | JobId): string {
  return id
}

export const RuntimeIdentityBindingSchema = z
  .object({
    itemIndex: z.number().int().nonnegative(),
    actualAgentId: AgentIdSchema,
    actualJobId: JobIdSchema.nullable(),
  })
  .strict()

export type RuntimeIdentityBinding = z.infer<typeof RuntimeIdentityBindingSchema>
