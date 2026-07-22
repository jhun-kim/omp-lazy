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
  const configured = override ?? parsed.data.agentModel
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
