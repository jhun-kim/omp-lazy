import { z } from "zod"
import { AgentIdSchema, JobIdSchema, runtimeIdValue } from "../contracts/agent-ids"

const jobListSchema = z.object({ list: z.literal(true) }).strict()
const jobDefaultSchema = z.object({}).strict()
const jobPollSchema = z.object({ poll: z.array(JobIdSchema).min(1) }).strict()
const jobCancelSchema = z.object({ cancel: z.array(JobIdSchema).min(1) }).strict()

export type ParsedJobControl =
  | {
      readonly ok: true
      readonly control: "job_snapshot" | "job_cancel"
      readonly inputKey: string
      readonly targets: readonly string[]
    }
  | { readonly ok: false }

export function parseJobControl(input: unknown): ParsedJobControl {
  const list = jobListSchema.safeParse(input)
  if (list.success) {
    return { ok: true, control: "job_snapshot", inputKey: JSON.stringify(list.data), targets: [] }
  }
  const implicit = jobDefaultSchema.safeParse(input)
  if (implicit.success) {
    return {
      ok: true,
      control: "job_snapshot",
      inputKey: JSON.stringify(implicit.data),
      targets: [],
    }
  }
  const poll = jobPollSchema.safeParse(input)
  if (poll.success) {
    return {
      ok: true,
      control: "job_snapshot",
      inputKey: JSON.stringify(poll.data),
      targets: poll.data.poll.map(runtimeIdValue),
    }
  }
  const cancel = jobCancelSchema.safeParse(input)
  if (!cancel.success) return { ok: false }
  return {
    ok: true,
    control: "job_cancel",
    inputKey: JSON.stringify(cancel.data),
    targets: cancel.data.cancel.map(runtimeIdValue),
  }
}

const ircSendSchema = z
  .object({
    op: z.literal("send"),
    to: AgentIdSchema,
    message: z.string().trim().min(1),
    replyTo: z.string().trim().min(1).optional(),
    await: z.boolean().optional(),
  })
  .strict()
const ircPassiveSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("list") }).strict(),
  z.object({ op: z.literal("inbox"), peek: z.boolean().optional() }).strict(),
  z
    .object({
      op: z.literal("wait"),
      from: AgentIdSchema.optional(),
      timeoutMs: z.number().nonnegative().optional(),
    })
    .strict(),
])

export type ParsedIrcControl =
  | {
      readonly ok: true
      readonly kind: "send"
      readonly inputKey: string
      readonly targets: readonly string[]
    }
  | {
      readonly ok: true
      readonly kind: "passive"
      readonly inputKey: string
      readonly targets: readonly string[]
    }
  | { readonly ok: false }

export function parseIrcControl(input: unknown): ParsedIrcControl {
  const send = ircSendSchema.safeParse(input)
  if (send.success) {
    return {
      ok: true,
      kind: "send",
      inputKey: JSON.stringify(send.data),
      targets: [runtimeIdValue(send.data.to)],
    }
  }
  const passive = ircPassiveSchema.safeParse(input)
  if (!passive.success) return { ok: false }
  return {
    ok: true,
    kind: "passive",
    inputKey: JSON.stringify(passive.data),
    targets:
      passive.data.op === "wait" && passive.data.from !== undefined
        ? [runtimeIdValue(passive.data.from)]
        : [],
  }
}
