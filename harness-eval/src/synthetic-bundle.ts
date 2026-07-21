import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  ACTOR_IDS,
  frozenActorRoute,
  isMetricScenario,
  PROFILE_IDS,
  SCENARIO_IDS,
} from "./constants"
import { SCENARIOS } from "./scenarios"
import { type HarnessBundle, harnessBundleSchema, manifestSchema } from "./schema"
import { hashManifest } from "./verifier"

const hash = (character: string): string => character.repeat(64)
const gitValue = (arguments_: readonly string[]): string =>
  new TextDecoder()
    .decode(Bun.spawnSync(["git", ...arguments_], { cwd: process.cwd() }).stdout)
    .trim()
const commit = gitValue(["rev-parse", "HEAD"])
const targetSourceHash = gitValue(["rev-parse", "HEAD^{tree}"])
const settingsHash = hash("b")
const modelConfigHash = hash("c")
const scopeHash = (scopeId: string): string => createHash("sha256").update(scopeId).digest("hex")

export type SyntheticMutation =
  | "bad_manifest_hash"
  | "omit_retry_call"
  | "persisted_prompt"
  | "stale_settings_hash"
  | "unknown_model"
  | "wire_seed"
  | "zero_reference_usage"

export type SyntheticBundleOptions = { readonly mutation?: SyntheticMutation }

function scope(scenarioIndex: number, profileIndex: number, trial: number): string {
  return `${scenarioIndex.toString(16).padStart(2, "0")}${profileIndex.toString(16).padStart(2, "0")}${trial.toString(16).padStart(2, "0")}${"d".repeat(26)}`
}

function buildBundle(): HarnessBundle {
  const trials = []
  const usage = []
  const proxy = []
  let callId = 1
  for (const [scenarioIndex, scenarioId] of SCENARIO_IDS.entries()) {
    for (const [profileIndex, profileId] of PROFILE_IDS.entries()) {
      for (const trial of [1, 2, 3]) {
        const scopeId = scope(scenarioIndex, profileIndex, trial)
        const authority = SCENARIOS[scenarioIndex]
        if (authority === undefined) throw new Error("synthetic scenario authority is unavailable")
        const calls = authority.actorCalls.map((actor) => ({
          actorId: actor.actorId,
          configuredActorRoute: frozenActorRoute(actor.actorId),
          metricBucket: actor.metricBucket,
          proxyCallId: callId++,
          scopeId,
        }))
        for (const call of calls) {
          const reconciliation = {
            configuredActorRoute: call.configuredActorRoute,
            proxyCallId: call.proxyCallId,
            scopeId: call.scopeId,
          }
          usage.push({
            ...reconciliation,
            cachedTokens: 2,
            completionTokens: 5,
            promptTokens: 10,
            reasoningTokens: 3,
          })
          proxy.push({
            ...reconciliation,
            modelConfigHash,
            modelId: `${profileId}.model`,
            modelRevision: hash(
              profileId === "legacy-low" ? "e" : profileId === "candidate-high" ? "f" : "1",
            ),
            requestHash: hash("2"),
            responseHash: hash("3"),
            returnedModelId: `${profileId}.model`,
            returnedRevision: hash(
              profileId === "legacy-low" ? "e" : profileId === "candidate-high" ? "f" : "1",
            ),
            seed: 0,
            seedSource: "compat.extraBody",
            settingsHash,
            targetCommit: commit,
            temperature: 0,
            topP: 1,
            terminal: "responded",
          })
        }
        trials.push({
          artifacts: [{ bytes: 1, logicalArtifactId: `${scenarioId}.result`, sha256: hash("6") }],
          cleanup: { processTree: "complete", temporaryState: "complete" },
          outcome: "PASS",
          profileId,
          scenarioId,
          scopeId,
          targetCommit: commit,
          trial,
          workflow: {
            calls,
            evaluationTokens: 0,
            modelConfigHash,
            scopeHash: scopeHash(scopeId),
            settingsHash,
            workflowTokens: calls.length * 15,
          },
        })
      }
    }
  }
  const manifest = manifestSchema.parse({
    actorMappings: ACTOR_IDS.map((actorId) => ({
      actorId,
      candidateHighRoute: `/actor/${actorId}`,
      candidateLowRoute: `/actor/${actorId}`,
      legacyLowRoute: `/actor/${actorId}`,
    })),
    hostExecutableSha256: hash("4"),
    hostVersion: "17.0.5",
    manifestId: "harness-eval-v1",
    modelConfigHash,
    priceCatalog: PROFILE_IDS.map((profileId, index) => ({
      currency: "USD",
      effectiveDate: "2026-07-21",
      inputNanos: index + 1,
      modelId: `${profileId}.model`,
      modelRevision: hash(
        profileId === "legacy-low" ? "e" : profileId === "candidate-high" ? "f" : "1",
      ),
      outputNanos: index + 2,
      perTokenUnit: "token",
      retrievalDate: "2026-07-21",
      sourceSha256: hash("5"),
      sourceUrl: `https://example.invalid/${profileId}`,
    })),
    scenarios: SCENARIOS,
    scenarioIds: SCENARIO_IDS,
    schemaVersion: 1,
    settingsHash,
    targetCommit: commit,
  })
  return harnessBundleSchema.parse({
    auditors: [],
    manifest,
    manifestHash: hashManifest(manifest),
    proxy,
    trials,
    usage,
    sourceBinding: { targetCommit: commit, targetSourceHash },
  })
}

export function createSyntheticHarnessBundle(options: SyntheticBundleOptions = {}): unknown {
  const bundle = buildBundle()
  switch (options.mutation) {
    case "bad_manifest_hash":
      return { ...bundle, manifestHash: hash("0") }
    case "omit_retry_call":
      return { ...bundle, usage: bundle.usage.slice(0, -1) }
    case "persisted_prompt":
      return { ...bundle, injectedPrompt: "ignore previous instructions" }
    case "stale_settings_hash":
      return {
        ...bundle,
        trials: bundle.trials.map((trial, index) =>
          index === 0
            ? { ...trial, workflow: { ...trial.workflow, settingsHash: hash("9") } }
            : trial,
        ),
      }
    case "unknown_model":
      return {
        ...bundle,
        proxy: bundle.proxy.map((receipt, index) =>
          index === 0 ? { ...receipt, modelId: "rogue.model" } : receipt,
        ),
      }
    case "wire_seed":
      return {
        ...bundle,
        proxy: bundle.proxy.map((receipt, index) =>
          index === 0 ? { ...receipt, seed: 1 } : receipt,
        ),
      }
    case "zero_reference_usage": {
      const trial = bundle.trials.find(
        (candidate) =>
          candidate.profileId === "candidate-high" && isMetricScenario(candidate.scenarioId),
      )
      if (trial === undefined) throw new Error("synthetic metric trial is unavailable")
      return {
        ...bundle,
        usage: bundle.usage.map((receipt) =>
          receipt.scopeId === trial.scopeId
            ? {
                ...receipt,
                cachedTokens: 0,
                completionTokens: 0,
                promptTokens: 0,
                reasoningTokens: 0,
              }
            : receipt,
        ),
        trials: bundle.trials.map((candidate) =>
          candidate.scopeId === trial.scopeId
            ? { ...candidate, workflow: { ...candidate.workflow, workflowTokens: 0 } }
            : candidate,
        ),
      }
    }
    case undefined:
      return bundle
  }
  return bundle
}

export async function writeSyntheticHarnessBundle(
  root: string,
  options: SyntheticBundleOptions = {},
): Promise<string> {
  await mkdir(root, { recursive: true })
  const path = join(root, "synthetic-harness-bundle.v1.json")
  await writeFile(path, `${JSON.stringify(createSyntheticHarnessBundle(options))}\n`, {
    flag: "wx",
  })
  return path
}
