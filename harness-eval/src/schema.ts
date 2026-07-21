import { z } from "zod"
import { ACTOR_IDS, PROFILE_IDS, SCENARIO_IDS } from "./constants"

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/)
const runtimeIdSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/)
const scopeIdSchema = z.string().regex(/^[a-f0-9]{32}$/)
const routeSchema = z.string().regex(/^\/actor\/[a-z][a-z0-9-]{0,63}$/)
const dateSchema = z.iso.date()
const nanosSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const logicalArtifactIdSchema = z
  .string()
  .regex(/^(?:[TF][0-9]{1,2}|[a-z][a-z0-9.-]{0,63}\.(?:calls|cleanup|result))$/)
const sourceUrlSchema = z
  .string()
  .regex(/^https:\/\/[a-z0-9.-]{1,128}(?:\/[A-Za-z0-9._~/-]{0,192})?$/)
const scopeHashSchema = sha256Schema

export const actorIdSchema = z.enum(ACTOR_IDS)
export const profileIdSchema = z.enum(PROFILE_IDS)
export const scenarioIdSchema = z.enum(SCENARIO_IDS)

export const actorRouteMappingSchema = z
  .object({
    actorId: actorIdSchema,
    candidateHighRoute: routeSchema,
    candidateLowRoute: routeSchema,
    legacyLowRoute: routeSchema,
  })
  .strict()

export const priceRecordSchema = z
  .object({
    currency: z.literal("USD"),
    effectiveDate: dateSchema,
    inputNanos: nanosSchema,
    modelId: runtimeIdSchema,
    modelRevision: sha256Schema,
    outputNanos: nanosSchema,
    perTokenUnit: z.literal("token"),
    retrievalDate: dateSchema,
    sourceSha256: sha256Schema,
    sourceUrl: sourceUrlSchema,
  })
  .strict()

const scenarioRowSchema = z
  .object({
    actorCalls: z
      .array(
        z.object({ actorId: actorIdSchema, maxCalls: z.number().int().min(0).max(28) }).strict(),
      )
      .max(5)
      .readonly(),
    constraints: z
      .object({
        allowedPathIds: z.array(runtimeIdSchema).max(8).readonly(),
        allowedStateEvents: z.array(runtimeIdSchema).max(8).readonly(),
        network: z
          .array(z.enum(["package-registry", "proxy"]))
          .max(2)
          .readonly(),
      })
      .strict(),
    expected: z
      .array(z.object({ kind: z.enum(["event", "refusal"]), value: runtimeIdSchema }).strict())
      .min(1)
      .max(3)
      .readonly(),
    fixture: z
      .object({
        expectedTreeHash: sha256Schema,
        templateId: z.enum([
          "approved-plan-v2",
          "empty-repo",
          "hostile-source",
          "lcx-defect",
          "legacy-state-v1",
          "team-two-slice",
          "ulw-v1",
        ]),
      })
      .strict(),
    id: scenarioIdSchema,
    predicates: z
      .array(
        z
          .object({
            hard: z.boolean(),
            id: runtimeIdSchema,
            oracleId: runtimeIdSchema,
            points: z.number().int().min(0).max(60),
          })
          .strict(),
      )
      .length(4)
      .readonly(),
    receipts: z.array(logicalArtifactIdSchema).length(3).readonly(),
    retrieval: z
      .object({
        maxBytes: z.number().int().min(0).max(163840),
        maxCalls: z.number().int().min(0).max(20),
      })
      .strict(),
    steps: z
      .array(
        z
          .object({
            command: z.enum([
              "doctor",
              "report",
              "start-work",
              "teammode",
              "ultrawork",
              "ulw-loop",
              "ulw-plan",
              "ulw-research",
            ]),
            source: z.literal("interactive"),
          })
          .strict(),
      )
      .min(1)
      .max(3)
      .readonly(),
    tier: z.enum(["DEEP", "FAST", "STANDARD"]),
    workflowCallCount: z.number().int().min(0).max(28),
  })
  .strict()

export const manifestSchema = z
  .object({
    actorMappings: z.array(actorRouteMappingSchema).length(ACTOR_IDS.length).readonly(),
    hostExecutableSha256: sha256Schema,
    hostVersion: z.literal("17.0.5"),
    manifestId: z.literal("harness-eval-v1"),
    modelConfigHash: sha256Schema,
    priceCatalog: z.array(priceRecordSchema).length(PROFILE_IDS.length).readonly(),
    scenarios: z.array(scenarioRowSchema).length(SCENARIO_IDS.length).readonly(),
    scenarioIds: z.array(scenarioIdSchema).length(SCENARIO_IDS.length).readonly(),
    schemaVersion: z.literal(1),
    settingsHash: sha256Schema,
    targetCommit: commitSchema,
  })
  .strict()

export const reconciliationKeySchema = z
  .object({
    configuredActorRoute: routeSchema,
    proxyCallId: z.number().int().positive(),
    scopeId: scopeIdSchema,
  })
  .strict()

export const workflowCallSchema = reconciliationKeySchema
  .extend({
    actorId: actorIdSchema,
    metricBucket: z.enum(["workflow", "critic"]),
  })
  .strict()

export const workflowReceiptSchema = z
  .object({
    calls: z.array(workflowCallSchema).max(28).readonly(),
    modelConfigHash: sha256Schema,
    scopeHash: scopeHashSchema,
    settingsHash: sha256Schema,
    evaluationTokens: z.literal(0),
    workflowTokens: z.number().int().nonnegative(),
  })
  .strict()

export const artifactReferenceSchema = z
  .object({
    bytes: z.number().int().nonnegative(),
    logicalArtifactId: logicalArtifactIdSchema,
    sha256: sha256Schema,
  })
  .strict()

export const trialReceiptSchema = z
  .object({
    artifacts: z.array(artifactReferenceSchema).min(1).max(3).readonly(),
    cleanup: z
      .object({ processTree: z.literal("complete"), temporaryState: z.literal("complete") })
      .strict(),
    outcome: z.enum(["PASS", "FAIL", "BLOCKED", "NOT_COMPARABLE"]),
    profileId: profileIdSchema,
    scenarioId: scenarioIdSchema,
    scopeId: scopeIdSchema,
    targetCommit: commitSchema,
    trial: z.number().int().min(1).max(3),
    workflow: workflowReceiptSchema,
  })
  .strict()

export const usageReceiptSchema = reconciliationKeySchema
  .extend({
    cachedTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    promptTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
  })
  .strict()

export const proxyReceiptSchema = reconciliationKeySchema
  .extend({
    modelConfigHash: sha256Schema,
    modelId: runtimeIdSchema,
    modelRevision: sha256Schema,
    requestHash: sha256Schema,
    responseHash: sha256Schema,
    returnedModelId: runtimeIdSchema,
    returnedRevision: sha256Schema,
    seed: z.literal(0),
    seedSource: z.literal("compat.extraBody"),
    settingsHash: sha256Schema,
    targetCommit: commitSchema,
    temperature: z.literal(0),
    topP: z.literal(1),
    terminal: z.literal("responded"),
  })
  .strict()

export const auditorReceiptSchema = z
  .object({
    actorId: z.enum(["quality-security", "oracle"]),
    inputHash: sha256Schema,
    outputHash: sha256Schema,
    status: z.enum(["PASS", "BLOCKED"]),
  })
  .strict()

export const harnessBundleSchema = z
  .object({
    auditors: z.array(auditorReceiptSchema).max(2).readonly(),
    manifest: manifestSchema,
    manifestHash: sha256Schema,
    proxy: z.array(proxyReceiptSchema).readonly(),
    trials: z.array(trialReceiptSchema).readonly(),
    usage: z.array(usageReceiptSchema).readonly(),
    sourceBinding: z
      .object({ targetCommit: commitSchema, targetSourceHash: commitSchema })
      .strict(),
  })
  .strict()

export type HarnessBundle = z.infer<typeof harnessBundleSchema>
export type Manifest = z.infer<typeof manifestSchema>
