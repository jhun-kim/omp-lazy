import { readFile } from "node:fs/promises"
import { z } from "zod"
import { PROFILE_IDS } from "./constants"

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const dateSchema = z.iso.date()
const runtimeIdSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/)
const sourceUrlSchema = z
  .string()
  .regex(/^https:\/\/[a-z0-9.-]{1,128}(?:\/[A-Za-z0-9._~/-]{0,192})?$/)

export const liveProfileInputSchema = z
  .object({
    profiles: z
      .array(
        z
          .object({
            effectiveDate: dateSchema,
            inputNanos: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            modelId: runtimeIdSchema,
            modelRevision: sha256Schema,
            outputNanos: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            profileId: z.enum(PROFILE_IDS),
            retrievalDate: dateSchema,
            sourceSha256: sha256Schema,
            sourceUrl: sourceUrlSchema,
          })
          .strict(),
      )
      .length(PROFILE_IDS.length)
      .refine(
        (profiles) =>
          new Set(profiles.map((profile) => profile.profileId)).size === PROFILE_IDS.length,
      ),
    schemaVersion: z.literal(1),
  })
  .strict()

export type LiveProfileInput = z.infer<typeof liveProfileInputSchema>

export type LiveProfileReceipt =
  | { readonly status: "PASS"; readonly value: LiveProfileInput }
  | {
      readonly code: "live_profile_input_missing" | "live_profile_input_schema_invalid"
      readonly status: "BLOCKED"
    }

export async function readLiveProfileInput(path: string): Promise<LiveProfileReceipt> {
  let input: unknown
  try {
    input = JSON.parse(await readFile(path, "utf8"))
  } catch {
    return { code: "live_profile_input_missing", status: "BLOCKED" }
  }
  const parsed = liveProfileInputSchema.safeParse(input)
  return parsed.success
    ? { status: "PASS", value: parsed.data }
    : { code: "live_profile_input_schema_invalid", status: "BLOCKED" }
}
