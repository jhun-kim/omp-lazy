import { isAbsolute } from "node:path"
import { z } from "zod"

export const evidenceStatusSchema = z.enum(["PASS", "FAIL", "BLOCKED", "NOT_RUN"])

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const commitShaSchema = z.string().regex(/^[a-f0-9]{40}$/)
const scenarioIdSchema = z.string().regex(/^G(?:0[1-9]|1[0-9]|2[0-5])$/)
const relativeEvidencePathSchema = z
  .string()
  .min(1)
  .refine(
    (path) => !isAbsolute(path) && !path.replaceAll("\\", "/").split("/").includes(".."),
    "evidence paths must be contained relative paths",
  )

export const rawEvidenceReferenceSchema = z
  .object({
    path: relativeEvidencePathSchema,
    sha256: sha256Schema,
  })
  .strict()

export const processEvidenceSchema = z
  .object({
    argv: z.array(z.string()).min(1).readonly(),
    cwd: z.string().min(1),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime(),
    durationMs: z.number().nonnegative(),
    deadlineMs: z.number().int().positive(),
    timedOut: z.boolean(),
    exitCode: z.number().int().nullable(),
    stdout: rawEvidenceReferenceSchema,
    stderr: rawEvidenceReferenceSchema,
  })
  .strict()

export const cleanupReceiptSchema = z
  .object({
    processTree: z.literal("complete"),
    sandbox: z.literal("complete"),
    residue: z.array(relativeEvidencePathSchema).readonly(),
  })
  .strict()

export const scenarioEvidenceSchema = z
  .object({
    scenarioId: scenarioIdSchema,
    status: evidenceStatusSchema,
    process: processEvidenceSchema,
    cleanup: cleanupReceiptSchema,
  })
  .strict()

export const evidenceBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().regex(/^[A-Za-z0-9._-]+$/),
    principal: z
      .object({
        identity: z.string().min(1),
        role: z.enum(["executor", "attestor"]),
      })
      .strict(),
    immutableInputs: z
      .object({
        commitSha: commitShaSchema,
        manifestSha256: sha256Schema,
        tarballSha256: sha256Schema.optional(),
      })
      .strict(),
    results: z.array(scenarioEvidenceSchema).min(1).readonly(),
  })
  .strict()

export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>
export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>
