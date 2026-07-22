import { z } from "zod"
import { type TaskTier, TaskTierSchema } from "../contracts/task-packet"

export const ModelRoleAliasSchema = z.enum(["@smol", "@task", "@slow"])
export type ModelRoleAlias = z.infer<typeof ModelRoleAliasSchema>

export const FailureFingerprintSchema = z.enum([
  "transport_transient",
  "semantic_mismatch",
  "test_failure",
  "new_boundary",
  "provider_unavailable",
  "authorization",
  "containment",
  "stale_state",
  "cleanup_failure",
  "unknown",
])
export type FailureFingerprint = z.infer<typeof FailureFingerprintSchema>

const TierRoles: Record<TaskTier, readonly ModelRoleAlias[]> = {
  FAST: ["@smol"],
  STANDARD: ["@smol", "@task"],
  DEEP: ["@smol", "@task", "@slow"],
}

type RouteAction = "DISPATCH" | "RESEND" | "ESCALATE" | "BLOCK" | "FAIL"

export type WorkerRouteReceipt = {
  readonly schemaVersion: 1
  readonly status: "PASS" | "BLOCKED"
  readonly action: RouteAction
  readonly tier: TaskTier
  readonly previousTier?: TaskTier
  readonly role: ModelRoleAlias
  readonly semanticAttempt: number
  readonly transportRequest: 1 | 2
  readonly allowedRoles: readonly ModelRoleAlias[]
  readonly code?: FailureFingerprint | "budget_exhausted"
}

export function initialWorkerRoute(tierValue: unknown): WorkerRouteReceipt {
  const tier = TaskTierSchema.parse(tierValue)
  return {
    schemaVersion: 1,
    status: "PASS",
    action: "DISPATCH",
    tier,
    role: "@smol",
    semanticAttempt: 1,
    transportRequest: 1,
    allowedRoles: TierRoles[tier],
  }
}

function nextRole(route: WorkerRouteReceipt): ModelRoleAlias | null {
  const position = route.allowedRoles.indexOf(route.role)
  return route.allowedRoles[position + 1] ?? null
}

function escalate(
  route: WorkerRouteReceipt,
  code: FailureFingerprint,
  tier: TaskTier = route.tier,
  previousTier?: TaskTier,
): WorkerRouteReceipt {
  const allowedRoles = TierRoles[tier]
  const position = allowedRoles.indexOf(route.role)
  const role = allowedRoles[position + 1]
  if (role === undefined) {
    return {
      ...route,
      status: "BLOCKED",
      action: "FAIL",
      code: "budget_exhausted",
    }
  }
  return {
    schemaVersion: 1,
    status: "PASS",
    action: "ESCALATE",
    tier,
    ...(previousTier === undefined ? {} : { previousTier }),
    role,
    semanticAttempt: route.semanticAttempt + 1,
    transportRequest: 1,
    allowedRoles,
    code,
  }
}

function block(route: WorkerRouteReceipt, code: FailureFingerprint): WorkerRouteReceipt {
  return { ...route, status: "BLOCKED", action: "BLOCK", code }
}

export function reduceWorkerFailure(
  route: WorkerRouteReceipt,
  failureValue: unknown,
): WorkerRouteReceipt {
  if (route.status === "BLOCKED") return route
  const failure = FailureFingerprintSchema.parse(failureValue)
  switch (failure) {
    case "transport_transient":
      return route.transportRequest === 1
        ? { ...route, action: "RESEND", transportRequest: 2, code: failure }
        : escalate(route, failure)
    case "provider_unavailable":
      return route.transportRequest === 1
        ? { ...route, action: "RESEND", transportRequest: 2, code: failure }
        : block(route, failure)
    case "new_boundary":
      return route.tier === "FAST"
        ? escalate(route, failure, "STANDARD", "FAST")
        : escalate(route, failure)
    case "semantic_mismatch":
    case "test_failure":
      return nextRole(route) === null
        ? { ...route, status: "BLOCKED", action: "FAIL", code: "budget_exhausted" }
        : escalate(route, failure)
    case "authorization":
    case "containment":
    case "stale_state":
    case "cleanup_failure":
    case "unknown":
      return block(route, failure)
    default:
      return failure satisfies never
  }
}
