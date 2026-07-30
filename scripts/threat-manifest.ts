import { z } from "zod"
import { HOSTILE_SCENARIO_IDS } from "./hostile-contract"
import { THREAT_ROWS_PRIMARY } from "./threat-rows-primary"
import { THREAT_ROWS_SECONDARY } from "./threat-rows-secondary"

const principalSchema = z.enum(["E-ARCH", "E-STATE", "E-ACT", "E-TEAM", "E-WORKFLOW", "E-PKG"])
const attestorSchema = z.enum(["A-STATE", "A-LIFE", "A-SEC", "A-PKG", "A-REL"])
const scenarioSchema = z
  .object({
    id: z.enum(HOSTILE_SCENARIO_IDS),
    priority: z.enum(["P0", "P1"]),
    risk: z.string().min(10),
    immutableInput: z.string().min(3),
    oracle: z.string().min(10),
    executor: principalSchema,
    attestors: z.array(attestorSchema).min(1).readonly(),
    timeoutMs: z.number().int().positive(),
    forbiddenSideEffects: z.array(z.string().min(3)).min(1).readonly(),
    evidencePath: z.string().regex(/^\.omo\/evidence\/[A-Za-z0-9{}/._-]+$/),
  })
  .strict()

const rows = [...THREAT_ROWS_PRIMARY, ...THREAT_ROWS_SECONDARY] as const

export const threatManifest = z
  .object({ schemaVersion: z.literal(1), scenarios: z.array(scenarioSchema).length(29).readonly() })
  .parse({
    schemaVersion: 1,
    scenarios: rows.map(
      ([
        id,
        priority,
        risk,
        immutableInput,
        oracle,
        executor,
        attestors,
        timeoutMs,
        forbiddenSideEffect,
        evidencePath,
      ]) => ({
        id,
        priority,
        risk,
        immutableInput,
        oracle,
        executor,
        attestors,
        timeoutMs,
        forbiddenSideEffects: [forbiddenSideEffect],
        evidencePath,
      }),
    ),
  })

export type ThreatScenario = (typeof threatManifest.scenarios)[number]
