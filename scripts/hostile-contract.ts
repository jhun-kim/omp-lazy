import { readFile, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { z } from "zod"

export const HOSTILE_SEEDS = [1357, 7331, 424242] as const
export const HOSTILE_REPEATS = 3 as const
export const HOSTILE_ENVIRONMENTS = ["enabled", "disabled", "unlinked"] as const
export const HOSTILE_SCENARIO_IDS = [
  "G01",
  "G02",
  "G03",
  "G04",
  "G05",
  "G06",
  "G07",
  "G08",
  "G09",
  "G10",
  "G11",
  "G12",
  "G13",
  "G14",
  "G15",
  "G16",
  "G17",
  "G18",
  "G19",
  "G20",
  "G21",
  "G22",
  "G23",
  "G24",
  "G25",
] as const
export const HOSTILE_SCENARIO_TIMEOUT_CAP_MS = 120_000 as const
export const HOSTILE_OVERALL_TIMEOUT_MS = 900_000 as const

export type HostileEnvironment = (typeof HOSTILE_ENVIRONMENTS)[number]
export type ScenarioId = (typeof HOSTILE_SCENARIO_IDS)[number]
export type RawReference = { readonly path: string; readonly sha256: string }
export type CapturedProcess = {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly deadlineMs: number
  readonly durationMs: number
  readonly endedAt: string
  readonly exitCode: number | null
  readonly processGroupOwned: boolean
  readonly startedAt: string
  readonly stderr: Uint8Array
  readonly stdout: Uint8Array
  readonly timedOut: boolean
}
export type CapturedProcessReference = Omit<CapturedProcess, "stderr" | "stdout"> & {
  readonly stderr: RawReference
  readonly stdout: RawReference
}

const filesSchema = z
  .array(z.string().regex(/^test\/.+\.test\.ts$/))
  .min(1)
  .readonly()
const scenarioMapSchema = z
  .object({
    G01: filesSchema,
    G02: filesSchema,
    G03: filesSchema,
    G04: filesSchema,
    G05: filesSchema,
    G06: filesSchema,
    G07: filesSchema,
    G08: filesSchema,
    G09: filesSchema,
    G10: filesSchema,
    G11: filesSchema,
    G12: filesSchema,
    G13: filesSchema,
    G14: filesSchema,
    G15: filesSchema,
    G16: filesSchema,
    G17: filesSchema,
    G18: filesSchema,
    G19: filesSchema,
    G20: filesSchema,
    G21: filesSchema,
    G22: filesSchema,
    G23: filesSchema,
    G24: filesSchema,
    G25: filesSchema,
  })
  .strict()

export type HostileScenarioMap = z.infer<typeof scenarioMapSchema>

export async function readHostileScenarioMap(
  candidate = process.cwd(),
): Promise<HostileScenarioMap> {
  const value: unknown = JSON.parse(
    await readFile(resolve(candidate, "test", "fixtures", "hostile-scenario-map.json"), "utf8"),
  )
  const map = scenarioMapSchema.parse(value)
  for (const scenarioId of HOSTILE_SCENARIO_IDS) {
    for (const file of map[scenarioId]) {
      if (!(await stat(resolve(candidate, file))).isFile()) {
        throw new TypeError(`hostile scenario ${scenarioId} missing test: ${file}`)
      }
    }
  }
  return map
}

export function hostileEnvironment(
  mode: HostileEnvironment,
  seed: number,
  repeat: number,
): Record<string, string | undefined> {
  return {
    ...process.env,
    OMP_LAZY_CRASH_POINT: "none",
    OMP_LAZY_EXTENSION_ENABLED: mode === "disabled" ? "0" : "1",
    OMP_LAZY_EXTENSION_LINKED: mode === "unlinked" ? "0" : "1",
    OMP_LAZY_HOSTILE_MODE: mode,
    OMP_LAZY_HOSTILE_REPEAT: String(repeat),
    OMP_LAZY_HOSTILE_SEED: String(seed),
  }
}
