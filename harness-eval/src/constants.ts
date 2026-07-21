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

export type FrozenScenarioPolicy = {
  readonly actors: readonly ActorId[]
  readonly maxCalls: number
  readonly tier: Tier
  readonly workflowCallCount: number
}

const metricPolicies = {
  "contribute.dry-run": {
    actors: ["parent", "worker-low", "worker-medium", "worker-high", "momus"],
    maxCalls: 11,
    tier: "DEEP",
    workflowCallCount: 5,
  },
  "plan.clear": {
    actors: ["parent", "planner"],
    maxCalls: 3,
    tier: "STANDARD",
    workflowCallCount: 2,
  },
  "plan.owner-decision": {
    actors: ["parent", "planner"],
    maxCalls: 3,
    tier: "STANDARD",
    workflowCallCount: 2,
  },
  "report.local": {
    actors: ["parent", "worker-low"],
    maxCalls: 3,
    tier: "FAST",
    workflowCallCount: 2,
  },
  "research.injection": {
    actors: ["parent", "researcher", "explorer"],
    maxCalls: 6,
    tier: "STANDARD",
    workflowCallCount: 3,
  },
  "research.single-wave": {
    actors: ["parent", "researcher"],
    maxCalls: 3,
    tier: "FAST",
    workflowCallCount: 2,
  },
  "start-work.complete": {
    actors: ["parent", "worker-low", "worker-medium"],
    maxCalls: 6,
    tier: "STANDARD",
    workflowCallCount: 3,
  },
  "teammode.parallel": {
    actors: ["parent", "worker-low"],
    maxCalls: 6,
    tier: "STANDARD",
    workflowCallCount: 2,
  },
  "ultrawork.fast": {
    actors: ["parent", "worker-low"],
    maxCalls: 3,
    tier: "FAST",
    workflowCallCount: 2,
  },
  "ultrawork.security": {
    actors: ["parent", "worker-low", "worker-medium", "worker-high", "momus"],
    maxCalls: 11,
    tier: "DEEP",
    workflowCallCount: 5,
  },
  "ulw-loop.complete": {
    actors: ["parent", "worker-low", "worker-medium"],
    maxCalls: 6,
    tier: "STANDARD",
    workflowCallCount: 3,
  },
  "ulw-loop.repeat-failure": {
    actors: ["parent", "worker-low", "worker-medium"],
    maxCalls: 6,
    tier: "STANDARD",
    workflowCallCount: 3,
  },
} as const satisfies Record<(typeof MODEL_METRIC_SCENARIO_IDS)[number], FrozenScenarioPolicy>

const zeroCallPolicy = { actors: [], maxCalls: 0, tier: "STANDARD", workflowCallCount: 0 } as const

export const FROZEN_SCENARIO_POLICIES: Readonly<Record<ScenarioId, FrozenScenarioPolicy>> = {
  ...metricPolicies,
  "contribute.non-dry": zeroCallPolicy,
  "cross.activation-injection": zeroCallPolicy,
  "cross.legacy-migration": zeroCallPolicy,
  "cross.no-progress": zeroCallPolicy,
  "cross.replay-cas": zeroCallPolicy,
  "cross.retry-isolation": zeroCallPolicy,
  "cross.stale-owner-head": zeroCallPolicy,
  "doctor.deep-unavailable": zeroCallPolicy,
  "doctor.shallow": zeroCallPolicy,
  "report.external-write": zeroCallPolicy,
  "start-work.stale-plan": zeroCallPolicy,
  "teammode.overlap": zeroCallPolicy,
}

export function frozenActorRoute(actorId: ActorId): string {
  return `/actor/${actorId}`
}

export function isMetricScenario(scenarioId: ScenarioId): boolean {
  return MODEL_METRIC_SCENARIO_IDS.some((metricScenarioId) => metricScenarioId === scenarioId)
}
