import { z } from "zod"
import { AgentIdSchema } from "../contracts/agent-ids"

const ircResultSchema = z
  .object({
    op: z.literal("send"),
    from: AgentIdSchema.optional(),
    to: z.string().optional(),
    receipts: z
      .array(
        z
          .object({
            to: AgentIdSchema,
            outcome: z.enum(["injected", "woken", "revived", "failed"]),
            error: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough()

export type IrcResultDetails = z.infer<typeof ircResultSchema>

export type IrcResultDecode =
  | { readonly ok: true; readonly value: IrcResultDetails }
  | { readonly ok: false; readonly code: "malformed_omp_17_0_5_irc_result" }

export function decodeIrcResult(details: unknown): IrcResultDecode {
  const parsed = ircResultSchema.safeParse(details)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, code: "malformed_omp_17_0_5_irc_result" }
}

const hubWaitResultSchema = z
  .object({
    op: z.literal("wait"),
    waited: z
      .object({
        id: z.string().min(1),
        from: AgentIdSchema,
        to: z.string().min(1),
        body: z.string(),
        ts: z.number().nonnegative(),
        replyTo: z.string().min(1).optional(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough()

export function isHubWaitMessageResult(details: unknown): boolean {
  return hubWaitResultSchema.safeParse(details).success
}
