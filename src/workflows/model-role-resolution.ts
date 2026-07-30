import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { type ModelRoleAlias, ModelRoleAliasSchema } from "./escalation-policy"

const selector = z.string().trim().min(1).max(512)
const modelPattern = z.union([selector, z.array(selector).min(1).max(8).readonly()])
const roleNameSchema = z.enum(["smol", "task", "slow"])
type RoleName = z.infer<typeof roleNameSchema>

const resolutionInputSchema = z
  .object({
    agentName: z.string().trim().min(1).max(160),
    agentModel: modelPattern.optional(),
    agentModelOverrides: z.record(z.string(), modelPattern),
    roleModels: z
      .object({
        smol: selector.optional(),
        task: selector.optional(),
        slow: selector.optional(),
      })
      .strict(),
    catalogModels: z.array(z.object({ provider: selector, model: selector }).strict()).readonly(),
    availableProviders: z.array(selector).readonly(),
  })
  .strict()

type ResolutionSource = "user_override" | "agent_default"

/**
 * Default role for every registered agent - the FIRST alias of that agent's model chain
 * as declared in the binding table (todo 18).
 */
const AgentNameDefaultRole: Record<string, string> = {
  "omp-lazy-worker-low": "@smol",
  "omp-lazy-worker-medium": "@task",
  "omp-lazy-worker-high": "@slow",
  "omp-lazy-explorer": "@smol",
  "omp-lazy-librarian": "@smol",
  "omp-lazy-researcher": "@task",
  "omp-lazy-planner": "@slow",
  "omp-lazy-metis": "@slow",
  "omp-lazy-momus": "@slow",
  "omp-lazy-qa": "@task",
  "omp-lazy-reviewer": "@slow",
}

/**
 * Returns the default role (first alias of the agent's declared chain) for a given agent name.
 * Returns undefined if the agent is not registered.
 */
export function resolveAgentDefaultRole(agentName: string): string | undefined {
  return AgentNameDefaultRole[agentName]
}

/** Maximum number of patterns allowed in a chain (from modelPattern schema). */
const MAX_CHAIN_LENGTH = 8

/** Per-attempt provenance entry (never contains vendor model ids). */
export type ProvenanceAttempt = {
  readonly agentName: string
  readonly attemptIndex: number
  readonly selector: string
  readonly role: RoleName | null
  readonly outcome: "resolved" | "provider_unavailable" | "model_unavailable" | "invalid_model_role"
}

/** The v2 provenance record written at model-chain-provenance/<runId>.json. */
export type ModelChainProvenanceRecord = {
  readonly schemaVersion: 2
  readonly runId: string
  readonly agentName: string
  readonly attempts: readonly ProvenanceAttempt[]
  readonly finalStatus: "PASS" | "BLOCKED"
  readonly resolvedAttemptIndex: number | null
}

/** Input for chain resolution (catalog-driven, pre-spawn). */
export type ChainResolutionInput = {
  readonly agentName: string
  readonly chain: readonly string[]
  readonly agentModelOverrides: Record<string, string | readonly string[]>
  readonly roleModels: { readonly smol?: string; readonly task?: string; readonly slow?: string }
  readonly catalogModels: readonly { readonly provider: string; readonly model: string }[]
  readonly availableProviders: readonly string[]
  readonly runId: string
  readonly stateRoot: string
}

/** Result of chain resolution including the receipt and the provenance record. */
export type ChainResolutionResult = {
  readonly receipt: ModelRoleResolutionReceiptV2
  readonly provenance: ModelChainProvenanceRecord | null
}

/** v2 receipt with per-attempt provenance - extends but does not break v1 shape. */
export type ModelRoleResolutionReceiptV2 =
  | {
      readonly schemaVersion: 2
      readonly status: "PASS"
      readonly agentName: string
      readonly source: ResolutionSource
      readonly selector: string
      readonly role: RoleName | null
      readonly provider: string
      readonly model: string
      readonly attemptIndex: number
      readonly attempts: readonly ProvenanceAttempt[]
    }
  | {
      readonly schemaVersion: 2
      readonly status: "BLOCKED"
      readonly agentName: string
      readonly source: ResolutionSource | null
      readonly selector: string | null
      readonly role: string | null
      readonly code:
        | "invalid_resolution_input"
        | "invalid_model_role"
        | "provider_unavailable"
        | "model_unavailable"
      readonly attempts: readonly ProvenanceAttempt[]
    }

/**
 * Resolves a model chain in order against the supplied catalog and providers.
 * Records per-attempt provenance as a schemaVersion 2 record at model-chain-provenance/<runId>.json.
 * Only an exhausted chain yields BLOCKED.
 */
export async function resolveWorkerModelChain(
  input: ChainResolutionInput,
): Promise<ChainResolutionResult> {
  const {
    agentName,
    chain,
    agentModelOverrides,
    roleModels,
    catalogModels,
    availableProviders,
    runId,
    stateRoot,
  } = input

  // Validate chain length
  if (chain.length === 0 || chain.length > MAX_CHAIN_LENGTH) {
    const blockedReceipt: ModelRoleResolutionReceiptV2 = {
      schemaVersion: 2,
      status: "BLOCKED",
      agentName,
      source: null,
      selector: null,
      role: null,
      code: "invalid_model_role",
      attempts: [],
    }
    return { receipt: blockedReceipt, provenance: null }
  }

  // Determine source
  const override = agentModelOverrides[agentName]
  const source: ResolutionSource = override !== undefined ? "user_override" : "agent_default"

  // Resolve the effective chain (override takes priority)
  const effectiveChain = override !== undefined ? patterns(override) : [...chain]

  const attempts: ProvenanceAttempt[] = []
  let resolvedReceipt: ModelRoleResolutionReceiptV2 | null = null

  for (let i = 0; i < effectiveChain.length; i++) {
    const candidate = effectiveChain[i]
    if (candidate === undefined) continue
    const alias = ModelRoleAliasSchema.safeParse(candidate)

    if (candidate.startsWith("@") && !alias.success) {
      attempts.push({
        agentName,
        attemptIndex: i,
        selector: candidate,
        role: null,
        outcome: "invalid_model_role",
      })
      // Invalid alias is a hard stop
      const blockedReceipt: ModelRoleResolutionReceiptV2 = {
        schemaVersion: 2,
        status: "BLOCKED",
        agentName,
        source,
        selector: candidate,
        role: candidate.slice(1) || null,
        code: "invalid_model_role",
        attempts,
      }
      await writeProvenance(stateRoot, runId, agentName, attempts, "BLOCKED", null)
      return {
        receipt: blockedReceipt,
        provenance: buildProvenance(runId, agentName, attempts, "BLOCKED", null),
      }
    }

    const role = alias.success ? roleName(alias.data) : null
    const resolvedSelector = role === null ? candidate : roleModels[role]

    if (resolvedSelector === undefined) {
      attempts.push({
        agentName,
        attemptIndex: i,
        selector: candidate,
        role,
        outcome: "invalid_model_role",
      })
      const blockedReceipt: ModelRoleResolutionReceiptV2 = {
        schemaVersion: 2,
        status: "BLOCKED",
        agentName,
        source,
        selector: candidate,
        role,
        code: "invalid_model_role",
        attempts,
      }
      await writeProvenance(stateRoot, runId, agentName, attempts, "BLOCKED", null)
      return {
        receipt: blockedReceipt,
        provenance: buildProvenance(runId, agentName, attempts, "BLOCKED", null),
      }
    }

    const slash = resolvedSelector.indexOf("/")
    if (slash <= 0 || slash === resolvedSelector.length - 1) {
      attempts.push({
        agentName,
        attemptIndex: i,
        selector: candidate,
        role,
        outcome: "invalid_model_role",
      })
      const blockedReceipt: ModelRoleResolutionReceiptV2 = {
        schemaVersion: 2,
        status: "BLOCKED",
        agentName,
        source,
        selector: candidate,
        role,
        code: "invalid_model_role",
        attempts,
      }
      await writeProvenance(stateRoot, runId, agentName, attempts, "BLOCKED", null)
      return {
        receipt: blockedReceipt,
        provenance: buildProvenance(runId, agentName, attempts, "BLOCKED", null),
      }
    }

    const provider = resolvedSelector.slice(0, slash)
    const model = resolvedSelector.slice(slash + 1)

    if (!availableProviders.includes(provider)) {
      attempts.push({
        agentName,
        attemptIndex: i,
        selector: candidate,
        role,
        outcome: "provider_unavailable",
      })
      continue
    }

    if (!catalogModels.some((cm) => cm.provider === provider && cm.model === model)) {
      attempts.push({
        agentName,
        attemptIndex: i,
        selector: candidate,
        role,
        outcome: "model_unavailable",
      })
      continue
    }

    // Resolved successfully
    attempts.push({
      agentName,
      attemptIndex: i,
      selector: candidate,
      role,
      outcome: "resolved",
    })

    resolvedReceipt = {
      schemaVersion: 2,
      status: "PASS",
      agentName,
      source,
      selector: candidate,
      role,
      provider,
      model,
      attemptIndex: i,
      attempts,
    }
    break
  }

  if (resolvedReceipt !== null) {
    await writeProvenance(
      stateRoot,
      runId,
      agentName,
      attempts,
      "PASS",
      resolvedReceipt.attemptIndex,
    )
    return {
      receipt: resolvedReceipt,
      provenance: buildProvenance(runId, agentName, attempts, "PASS", resolvedReceipt.attemptIndex),
    }
  }

  // Exhausted chain
  const lastAttempt = attempts[attempts.length - 1]
  const blockedReceipt: ModelRoleResolutionReceiptV2 = {
    schemaVersion: 2,
    status: "BLOCKED",
    agentName,
    source,
    selector: lastAttempt?.selector ?? null,
    role: lastAttempt?.role ?? null,
    code: "model_unavailable",
    attempts,
  }
  await writeProvenance(stateRoot, runId, agentName, attempts, "BLOCKED", null)
  return {
    receipt: blockedReceipt,
    provenance: buildProvenance(runId, agentName, attempts, "BLOCKED", null),
  }
}

function buildProvenance(
  runId: string,
  agentName: string,
  attempts: readonly ProvenanceAttempt[],
  finalStatus: "PASS" | "BLOCKED",
  resolvedAttemptIndex: number | null,
): ModelChainProvenanceRecord {
  return {
    schemaVersion: 2,
    runId,
    agentName,
    attempts,
    finalStatus,
    resolvedAttemptIndex,
  }
}

async function writeProvenance(
  stateRoot: string,
  runId: string,
  agentName: string,
  attempts: readonly ProvenanceAttempt[],
  finalStatus: "PASS" | "BLOCKED",
  resolvedAttemptIndex: number | null,
): Promise<void> {
  const record = buildProvenance(runId, agentName, attempts, finalStatus, resolvedAttemptIndex)
  const filePath = join(stateRoot, "model-chain-provenance", `${runId}.json`)
  await mkdir(dirname(filePath), { recursive: true })
  // Atomic write: write complete JSON string in one shot
  const bytes = JSON.stringify(record, null, 2)
  await writeFile(filePath, bytes, "utf8")
}

export type ModelRoleResolutionReceipt =
  | {
      readonly schemaVersion: 1
      readonly status: "PASS"
      readonly agentName: string
      readonly source: ResolutionSource
      readonly selector: string
      readonly role: RoleName | null
      readonly provider: string
      readonly model: string
    }
  | {
      readonly schemaVersion: 1
      readonly status: "BLOCKED"
      readonly agentName: string | null
      readonly source: ResolutionSource | null
      readonly selector: string | null
      readonly role: string | null
      readonly code:
        | "invalid_resolution_input"
        | "invalid_model_role"
        | "provider_unavailable"
        | "model_unavailable"
    }

function patterns(value: string | readonly string[]): readonly string[] {
  const values = typeof value === "string" ? [value] : value
  return values
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function roleName(value: ModelRoleAlias): RoleName {
  switch (value) {
    case "@smol":
      return "smol"
    case "@task":
      return "task"
    case "@slow":
      return "slow"
    default:
      return value satisfies never
  }
}

function blocked(
  input: {
    readonly agentName: string
    readonly source: ResolutionSource
    readonly selector: string
  },
  role: string | null,
  code: Exclude<ModelRoleResolutionReceipt, { readonly status: "PASS" }>["code"],
): ModelRoleResolutionReceipt {
  return {
    schemaVersion: 1,
    status: "BLOCKED",
    agentName: input.agentName,
    source: input.source,
    selector: input.selector,
    role,
    code,
  }
}

export function resolveWorkerModelRole(inputValue: unknown): ModelRoleResolutionReceipt {
  const parsed = resolutionInputSchema.safeParse(inputValue)
  if (!parsed.success) {
    return {
      schemaVersion: 1,
      status: "BLOCKED",
      agentName: null,
      source: null,
      selector: null,
      role: null,
      code: "invalid_resolution_input",
    }
  }
  const override = parsed.data.agentModelOverrides[parsed.data.agentName]
  const source: ResolutionSource = override === undefined ? "agent_default" : "user_override"
  const configured =
    override ?? parsed.data.agentModel ?? AgentNameDefaultRole[parsed.data.agentName]
  if (configured === undefined) {
    return blocked(
      { agentName: parsed.data.agentName, source, selector: "" },
      null,
      "invalid_model_role",
    )
  }
  const candidates = patterns(configured)
  let lastFailure: ModelRoleResolutionReceipt | null = null
  for (const candidate of candidates) {
    const alias = ModelRoleAliasSchema.safeParse(candidate)
    if (candidate.startsWith("@") && !alias.success) {
      return blocked(
        { agentName: parsed.data.agentName, source, selector: candidate },
        candidate.slice(1) || null,
        "invalid_model_role",
      )
    }
    const role = alias.success ? roleName(alias.data) : null
    const resolvedSelector = role === null ? candidate : parsed.data.roleModels[role]
    if (resolvedSelector === undefined) {
      return blocked(
        { agentName: parsed.data.agentName, source, selector: candidate },
        role,
        "invalid_model_role",
      )
    }
    const slash = resolvedSelector.indexOf("/")
    if (slash <= 0 || slash === resolvedSelector.length - 1) {
      return blocked(
        { agentName: parsed.data.agentName, source, selector: candidate },
        role,
        "invalid_model_role",
      )
    }
    const provider = resolvedSelector.slice(0, slash)
    const model = resolvedSelector.slice(slash + 1)
    if (!parsed.data.availableProviders.includes(provider)) {
      lastFailure = blocked(
        { agentName: parsed.data.agentName, source, selector: candidate },
        role,
        "provider_unavailable",
      )
      continue
    }
    if (
      !parsed.data.catalogModels.some(
        (catalogModel) => catalogModel.provider === provider && catalogModel.model === model,
      )
    ) {
      lastFailure = blocked(
        { agentName: parsed.data.agentName, source, selector: candidate },
        role,
        "model_unavailable",
      )
      continue
    }
    return {
      schemaVersion: 1,
      status: "PASS",
      agentName: parsed.data.agentName,
      source,
      selector: candidate,
      role,
      provider,
      model,
    }
  }
  return (
    lastFailure ??
    blocked({ agentName: parsed.data.agentName, source, selector: "" }, null, "invalid_model_role")
  )
}
