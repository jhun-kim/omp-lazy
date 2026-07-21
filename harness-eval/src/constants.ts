export const SCENARIO_IDS = [
  "plan.clear",
  "plan.owner-decision",
  "start-work.complete",
  "start-work.stale-plan",
  "ulw-loop.complete",
  "ulw-loop.repeat-failure",
  "ultrawork.fast",
  "ultrawork.security",
  "teammode.parallel",
  "teammode.overlap",
  "research.single-wave",
  "research.injection",
  "doctor.shallow",
  "doctor.deep-unavailable",
  "report.local",
  "report.external-write",
  "contribute.dry-run",
  "contribute.non-dry",
  "cross.activation-injection",
  "cross.replay-cas",
  "cross.stale-owner-head",
  "cross.no-progress",
  "cross.retry-isolation",
  "cross.legacy-migration",
] as const

export const PROFILE_IDS = ["legacy-low", "candidate-high", "candidate-low"] as const

export const ACTOR_IDS = [
  "parent",
  "worker-low",
  "worker-medium",
  "worker-high",
  "planner",
  "metis",
  "momus",
  "explorer",
  "librarian",
  "researcher",
  "reviewer",
  "qa",
  "critic",
  "evaluator",
  "quality-security",
  "oracle",
] as const

export const MODEL_METRIC_SCENARIO_IDS = [
  "plan.clear",
  "plan.owner-decision",
  "start-work.complete",
  "ulw-loop.complete",
  "ulw-loop.repeat-failure",
  "ultrawork.fast",
  "ultrawork.security",
  "teammode.parallel",
  "research.single-wave",
  "research.injection",
  "report.local",
  "contribute.dry-run",
] as const

export const DIRECT_SCENARIO_IDS = SCENARIO_IDS.filter(
  (scenarioId) => !isMetricScenario(scenarioId),
)

export type ScenarioId = (typeof SCENARIO_IDS)[number]
export type ProfileId = (typeof PROFILE_IDS)[number]
export type ActorId = (typeof ACTOR_IDS)[number]

export type Tier = "DEEP" | "FAST" | "STANDARD"

export function frozenActorRoute(actorId: ActorId): string {
  return `/actor/${actorId}`
}

export function isMetricScenario(scenarioId: ScenarioId): boolean {
  return MODEL_METRIC_SCENARIO_IDS.some((metricScenarioId) => metricScenarioId === scenarioId)
}
