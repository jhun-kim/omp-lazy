import { createHash } from "node:crypto"
import {
  ACTOR_IDS,
  frozenActorRoute,
  isMetricScenario,
  PROFILE_IDS,
  SCENARIO_IDS,
} from "./constants"
import { SCENARIOS } from "./scenarios"
import { type HarnessBundle, harnessBundleSchema, type Manifest } from "./schema"

export const rejectionCodes = [
  "actor_mapping_cardinality",
  "actor_route_policy",
  "actor_route_mismatch",
  "hard_gate_failed",
  "manifest_hash_mismatch",
  "model_config_hash_mismatch",
  "scenario_cardinality",
  "scenario_authority_mismatch",
  "settings_hash_mismatch",
  "scope_binding_mismatch",
  "target_commit_mismatch",
  "trial_cardinality",
  "unknown_field",
  "unknown_model",
  "usage_call_missing",
  "usage_call_unexpected",
  "usage_fields_missing",
  "wire_sampling_mismatch",
  "zero_reference_usage",
] as const

export type RejectionCode = (typeof rejectionCodes)[number]
export type VerificationReceipt =
  | { readonly status: "PASS" }
  | { readonly code: RejectionCode; readonly status: "FAIL" }

type CallKey = `${string}:${string}:${number}`

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

export function hashManifest(manifest: Manifest): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex")
}

function failure(code: RejectionCode): VerificationReceipt {
  return { code, status: "FAIL" }
}

function keyOf(value: {
  readonly configuredActorRoute: string
  readonly proxyCallId: number
  readonly scopeId: string
}): CallKey {
  return `${value.scopeId}:${value.configuredActorRoute}:${value.proxyCallId}`
}

function hasExactValues(values: readonly string[], expected: readonly string[]): boolean {
  return JSON.stringify(values) === JSON.stringify(expected)
}

function authorityCallsAreBounded(authority: (typeof SCENARIOS)[number]): boolean {
  const actorCapacity = authority.actorCalls.reduce((total, actor) => total + actor.maxCalls, 0)
  return authority.workflowCallCount >= actorCapacity
}

function verifyManifest(manifest: Manifest): RejectionCode | undefined {
  if (!hasExactValues(manifest.scenarioIds, SCENARIO_IDS)) return "scenario_cardinality"
  if (new Set(manifest.actorMappings.map((mapping) => mapping.actorId)).size !== ACTOR_IDS.length) {
    return "actor_mapping_cardinality"
  }
  if (new Set(manifest.priceCatalog.map((price) => price.modelId)).size !== PROFILE_IDS.length) {
    return "unknown_model"
  }
  if (
    manifest.actorMappings.some(
      (mapping) =>
        mapping.legacyLowRoute !== frozenActorRoute(mapping.actorId) ||
        mapping.candidateHighRoute !== frozenActorRoute(mapping.actorId) ||
        mapping.candidateLowRoute !== frozenActorRoute(mapping.actorId),
    )
  ) {
    return "actor_route_policy"
  }
  if (
    !hasExactValues(
      manifest.scenarios.map((row) => row.id),
      SCENARIO_IDS,
    )
  )
    return "scenario_cardinality"
  if (
    manifest.scenarios.some((row, index) => canonicalJson(row) !== canonicalJson(SCENARIOS[index]))
  ) {
    return "scenario_authority_mismatch"
  }
  if (SCENARIOS.some((authority) => !authorityCallsAreBounded(authority))) {
    return "scenario_authority_mismatch"
  }
  return undefined
}

function verifyTrialCardinality(bundle: HarnessBundle): RejectionCode | undefined {
  if (bundle.trials.length !== SCENARIO_IDS.length * PROFILE_IDS.length * 3)
    return "trial_cardinality"
  const expected = new Set<string>()
  for (const scenarioId of SCENARIO_IDS) {
    for (const profileId of PROFILE_IDS) {
      for (const trial of [1, 2, 3]) expected.add(`${scenarioId}:${profileId}:${trial}`)
    }
  }
  const actual = new Set(
    bundle.trials.map((trial) => `${trial.scenarioId}:${trial.profileId}:${trial.trial}`),
  )
  if (new Set(bundle.trials.map((trial) => trial.scopeId)).size !== bundle.trials.length)
    return "scope_binding_mismatch"
  return actual.size === expected.size && [...expected].every((key) => actual.has(key))
    ? undefined
    : "trial_cardinality"
}

function verifyCalls(bundle: HarnessBundle): RejectionCode | undefined {
  const workflowCalls = bundle.trials.flatMap((trial) => trial.workflow.calls)
  const expectedKeys = new Set(workflowCalls.map(keyOf))
  const usageKeys = new Set(bundle.usage.map(keyOf))
  const proxyKeys = new Set(bundle.proxy.map(keyOf))
  if ([...expectedKeys].some((key) => !usageKeys.has(key) || !proxyKeys.has(key)))
    return "usage_call_missing"
  if (
    [...usageKeys].some((key) => !expectedKeys.has(key)) ||
    [...proxyKeys].some((key) => !expectedKeys.has(key))
  ) {
    return "usage_call_unexpected"
  }
  if (bundle.proxy.some((proxy, index) => proxy.proxyCallId !== index + 1))
    return "usage_call_unexpected"
  if (
    expectedKeys.size !== workflowCalls.length ||
    usageKeys.size !== bundle.usage.length ||
    proxyKeys.size !== bundle.proxy.length
  ) {
    return "usage_call_unexpected"
  }
  return undefined
}

function verifyUsageAndProxy(bundle: HarnessBundle): RejectionCode | undefined {
  const usageByKey = new Map(bundle.usage.map((usage) => [keyOf(usage), usage]))
  const proxyByKey = new Map(bundle.proxy.map((proxy) => [keyOf(proxy), proxy]))
  for (const trial of bundle.trials) {
    const authority = SCENARIOS[SCENARIO_IDS.indexOf(trial.scenarioId)]
    if (authority === undefined) return "scenario_authority_mismatch"
    if (createHash("sha256").update(trial.scopeId).digest("hex") !== trial.workflow.scopeHash)
      return "scope_binding_mismatch"
    if (trial.workflow.calls.some((call) => call.scopeId !== trial.scopeId))
      return "scope_binding_mismatch"
    if (trial.workflow.calls.length > authority.workflowCallCount) return "usage_call_unexpected"
    for (const allowed of authority.actorCalls) {
      const observed = trial.workflow.calls.filter((call) => call.actorId === allowed.actorId)
      const requiredCalls = authority.actorCalls.filter(
        (required) => required.actorId === allowed.actorId,
      ).length
      if (observed.length < requiredCalls) return "usage_call_missing"
      if (
        observed.length > allowed.maxCalls ||
        observed.some((call) => call.metricBucket !== allowed.metricBucket)
      )
        return "actor_route_policy"
    }
    if (
      trial.workflow.calls.some(
        (call) => !authority.actorCalls.some((allowed) => allowed.actorId === call.actorId),
      )
    )
      return "actor_route_policy"
    if (trial.workflow.settingsHash !== bundle.manifest.settingsHash)
      return "settings_hash_mismatch"
    if (trial.workflow.modelConfigHash !== bundle.manifest.modelConfigHash)
      return "model_config_hash_mismatch"
    let total = 0
    for (const call of trial.workflow.calls) {
      if (call.configuredActorRoute !== frozenActorRoute(call.actorId)) return "actor_route_policy"
      if (call.metricBucket === "critic" && call.actorId !== "momus" && call.actorId !== "reviewer")
        return "actor_route_policy"
      if (
        call.metricBucket === "workflow" &&
        (call.actorId === "evaluator" || call.actorId === "critic")
      )
        return "actor_route_policy"
      if (call.actorId === "momus" && call.metricBucket !== "critic") return "actor_route_policy"
      const key = keyOf(call)
      const usage = usageByKey.get(key)
      const proxy = proxyByKey.get(key)
      if (usage === undefined || proxy === undefined) return "usage_call_missing"
      if (
        usage.reasoningTokens > usage.completionTokens ||
        usage.cachedTokens > usage.promptTokens
      ) {
        return "usage_fields_missing"
      }
      if (proxy.temperature !== 0 || proxy.topP !== 1 || proxy.seed !== 0)
        return "wire_sampling_mismatch"
      if (proxy.seedSource !== "compat.extraBody") return "wire_sampling_mismatch"
      if (proxy.settingsHash !== trial.workflow.settingsHash) return "settings_hash_mismatch"
      if (proxy.modelConfigHash !== trial.workflow.modelConfigHash)
        return "model_config_hash_mismatch"
      if (proxy.targetCommit !== trial.targetCommit || proxy.terminal !== "responded")
        return "target_commit_mismatch"
      const price = bundle.manifest.priceCatalog[PROFILE_IDS.indexOf(trial.profileId)]
      if (
        price === undefined ||
        proxy.modelId !== price.modelId ||
        proxy.returnedModelId !== price.modelId
      ) {
        return "unknown_model"
      }
      if (
        proxy.modelRevision !== price.modelRevision ||
        proxy.returnedRevision !== price.modelRevision
      ) {
        return "unknown_model"
      }
      total += usage.promptTokens + usage.completionTokens
    }
    if (total !== trial.workflow.workflowTokens) return "usage_fields_missing"
    if (trial.targetCommit !== bundle.manifest.targetCommit) return "target_commit_mismatch"
    if (trial.profileId !== "legacy-low" && trial.outcome !== "PASS") return "hard_gate_failed"
    if (!isMetricScenario(trial.scenarioId) && trial.workflow.calls.length !== 0)
      return "usage_call_unexpected"
    if (trial.profileId === "candidate-high" && isMetricScenario(trial.scenarioId) && total === 0) {
      return "zero_reference_usage"
    }
  }
  return undefined
}

function verifyCosts(bundle: HarnessBundle): RejectionCode | undefined {
  const priceByProfile = new Map(
    PROFILE_IDS.map((profileId, index) => [profileId, bundle.manifest.priceCatalog[index]]),
  )
  for (const trial of bundle.trials) {
    const price = priceByProfile.get(trial.profileId)
    if (price === undefined) return "unknown_model"
    for (const call of trial.workflow.calls) {
      const usage = bundle.usage.find((receipt) => keyOf(receipt) === keyOf(call))
      if (usage === undefined) return "usage_call_missing"
      const cost =
        BigInt(usage.promptTokens) * BigInt(price.inputNanos) +
        BigInt(usage.completionTokens) * BigInt(price.outputNanos)
      if (cost < 0n) return "usage_fields_missing"
    }
  }
  return undefined
}

export function verifyHarnessBundle(input: unknown): VerificationReceipt {
  const parsed = harnessBundleSchema.safeParse(input)
  if (!parsed.success) {
    if (
      parsed.error.issues.some(
        (issue) =>
          issue.path[0] === "proxy" &&
          (issue.path.includes("seed") ||
            issue.path.includes("temperature") ||
            issue.path.includes("topP")),
      )
    ) {
      return failure("wire_sampling_mismatch")
    }
    return parsed.error.issues.some(
      (issue) =>
        issue.path[0] === "usage" &&
        (issue.path.includes("promptTokens") || issue.path.includes("completionTokens")),
    )
      ? failure("usage_fields_missing")
      : failure("unknown_field")
  }
  const bundle = parsed.data
  if (hashManifest(bundle.manifest) !== bundle.manifestHash)
    return failure("manifest_hash_mismatch")
  if (
    bundle.sourceBinding.targetCommit !== bundle.manifest.targetCommit ||
    bundle.trials.some((trial) => trial.targetCommit !== bundle.sourceBinding.targetCommit)
  ) {
    return failure("target_commit_mismatch")
  }
  const actualCommit = new TextDecoder()
    .decode(Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout)
    .trim()
  const actualTree = new TextDecoder()
    .decode(Bun.spawnSync(["git", "rev-parse", "HEAD^{tree}"]).stdout)
    .trim()
  if (
    bundle.sourceBinding.targetCommit !== actualCommit ||
    bundle.sourceBinding.targetSourceHash !== actualTree
  )
    return failure("target_commit_mismatch")
  if (bundle.manifest.priceCatalog.some((price) => /^(sk-|api[-_]?key|token)/i.test(price.modelId)))
    return failure("unknown_model")
  const checks = [
    verifyManifest(bundle.manifest),
    verifyTrialCardinality(bundle),
    verifyCalls(bundle),
    verifyUsageAndProxy(bundle),
    verifyCosts(bundle),
  ]
  const code = checks.find((check): check is RejectionCode => check !== undefined)
  return code === undefined ? { status: "PASS" } : failure(code)
}
