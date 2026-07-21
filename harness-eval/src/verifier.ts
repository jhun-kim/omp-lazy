import { createHash } from "node:crypto"
import { ACTOR_IDS, isMetricScenario, PROFILE_IDS, SCENARIO_IDS } from "./constants"
import { type HarnessBundle, harnessBundleSchema, type Manifest } from "./schema"

export const rejectionCodes = [
  "actor_mapping_cardinality",
  "actor_route_mismatch",
  "hard_gate_failed",
  "manifest_hash_mismatch",
  "model_config_hash_mismatch",
  "scenario_cardinality",
  "settings_hash_mismatch",
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

function verifyManifest(manifest: Manifest): RejectionCode | undefined {
  if (!hasExactValues(manifest.scenarioIds, SCENARIO_IDS)) return "scenario_cardinality"
  if (new Set(manifest.actorMappings.map((mapping) => mapping.actorId)).size !== ACTOR_IDS.length) {
    return "actor_mapping_cardinality"
  }
  if (new Set(manifest.priceCatalog.map((price) => price.modelId)).size !== PROFILE_IDS.length) {
    return "unknown_model"
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
    if (trial.workflow.settingsHash !== bundle.manifest.settingsHash)
      return "settings_hash_mismatch"
    if (trial.workflow.modelConfigHash !== bundle.manifest.modelConfigHash)
      return "model_config_hash_mismatch"
    let total = 0
    for (const call of trial.workflow.calls) {
      const mapping = bundle.manifest.actorMappings.find(
        (candidate) => candidate.actorId === call.actorId,
      )
      const expectedRoute =
        trial.profileId === "legacy-low"
          ? mapping?.legacyLowRoute
          : trial.profileId === "candidate-high"
            ? mapping?.candidateHighRoute
            : mapping?.candidateLowRoute
      if (expectedRoute !== call.configuredActorRoute) return "actor_route_mismatch"
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
