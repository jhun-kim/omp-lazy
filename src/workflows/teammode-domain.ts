import { isAbsolute, posix } from "node:path"
import { z } from "zod"
import { AgentIdSchema, JobIdSchema } from "../contracts/agent-ids"
import { WorkerRoleSchema } from "../contracts/evidence-receipt"
import { UuidSchema } from "../state/domain"

export const TeamNameSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(64)

const text = z.string().trim().min(1).max(1_024)
const ownedPath = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .superRefine((value, context) => {
    const normalized = value.replaceAll("\\", "/")
    if (isAbsolute(value) || normalized.startsWith("/") || normalized.split("/").includes("..")) {
      context.addIssue({ code: "custom", message: "ownership must be repository-relative" })
    }
  })

const memberDefinitionSchema = z
  .object({
    requestedName: TeamNameSchema,
    agentType: WorkerRoleSchema,
    focus: text,
    ownership: z.array(ownedPath).min(1).max(32).readonly(),
    deliverable: text,
    isolated: z.boolean(),
  })
  .strict()

function normalizedOwnership(value: string): string {
  const normalized = posix
    .normalize(value.replaceAll("\\", "/"))
    .replace(/^\.\//, "")
    .replace(/\/$/, "")
  return normalized === "" ? "." : normalized
}

function pathsOverlap(left: string, right: string): boolean {
  return (
    left === "." ||
    right === "." ||
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  )
}

export const TeamDefinitionSchema = z
  .object({
    teamName: TeamNameSchema,
    members: z.array(memberDefinitionSchema).min(2).max(8).readonly(),
  })
  .strict()
  .superRefine((team, context) => {
    if (new Set(team.members.map((member) => member.requestedName)).size !== team.members.length) {
      context.addIssue({ code: "custom", message: "member names must be unique" })
    }
    const claims = team.members.flatMap((member) =>
      member.ownership.map((path) => ({
        member: member.requestedName,
        path: normalizedOwnership(path),
      })),
    )
    for (let left = 0; left < claims.length; left += 1) {
      for (let right = left + 1; right < claims.length; right += 1) {
        const a = claims[left]
        const b = claims[right]
        if (
          a !== undefined &&
          b !== undefined &&
          a.member !== b.member &&
          pathsOverlap(a.path, b.path)
        ) {
          context.addIssue({ code: "custom", message: "member ownership overlaps" })
          return
        }
      }
    }
  })

const runtimeMemberSchema = memberDefinitionSchema
  .extend({
    actualAgentId: AgentIdSchema.nullable(),
    actualJobId: JobIdSchema.nullable(),
    worktreePath: z.string().min(1).nullable(),
    acceptanceKey: z.string().min(1).nullable(),
  })
  .strict()

export const TeamStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    teamName: TeamNameSchema,
    runId: UuidSchema,
    attempt: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
    status: z.enum(["initializing", "active", "completed", "cancelled", "archived"]),
    members: z.array(runtimeMemberSchema).min(2).max(8).readonly(),
  })
  .strict()
  .superRefine((team, context) => {
    const initializing = team.status === "initializing"
    const archivedBound =
      team.status === "archived" && team.members.some((member) => member.actualAgentId !== null)
    const requiresIdentity =
      team.status === "active" || team.status === "completed" || archivedBound
    const invalid = team.members.some((member) =>
      initializing
        ? member.actualAgentId !== null ||
          member.actualJobId !== null ||
          member.acceptanceKey !== null
        : requiresIdentity && (member.actualAgentId === null || member.actualJobId === null),
    )
    const missingAcceptance =
      (team.status === "completed" || archivedBound) &&
      team.members.some((member) => member.acceptanceKey === null)
    const actualIds = team.members.flatMap((member) =>
      member.actualAgentId === null ? [] : [member.actualAgentId],
    )
    if (invalid || missingAcceptance || new Set(actualIds).size !== actualIds.length) {
      context.addIssue({ code: "custom", message: "team lifecycle binding mismatch" })
    }
  })

export type TeamDefinition = z.infer<typeof TeamDefinitionSchema>
export type TeamState = z.infer<typeof TeamStateSchema>
export type TeamCaller = {
  readonly sessionId: string
  readonly cwd: string
  readonly toolNames: readonly string[]
}
export type TeamResult =
  | {
      readonly ok: true
      readonly status:
        | "created"
        | "replayed"
        | "bound"
        | "completed"
        | "cancelled"
        | "resumed"
        | "archived"
        | "deleted"
      readonly state?: TeamState
      readonly runtimeAgentsArchived?: false
    }
  | { readonly ok: false; readonly code: string }

export type TeamWorktreeBinding = { readonly requestedName: string; readonly path: string }

function teamDefinitionKey(
  teamName: TeamDefinition["teamName"],
  members: TeamDefinition["members"],
): string {
  const canonicalMembers = members
    .map((member) => ({
      requestedName: member.requestedName,
      agentType: member.agentType,
      focus: member.focus,
      ownership: member.ownership.map(normalizedOwnership).sort(),
      deliverable: member.deliverable,
      isolated: member.isolated,
    }))
    .sort((left, right) => left.requestedName.localeCompare(right.requestedName))
  return JSON.stringify({ teamName, members: canonicalMembers })
}

export function matchesTeamDefinition(state: TeamState, definition: TeamDefinition): boolean {
  return (
    teamDefinitionKey(state.teamName, state.members) ===
    teamDefinitionKey(definition.teamName, definition.members)
  )
}

export function matchesTeamWorktreeBindings(
  state: TeamState,
  bindings: readonly TeamWorktreeBinding[],
): boolean {
  const actual = new Map(bindings.map((binding) => [binding.requestedName, binding.path]))
  const expected = state.members.flatMap((member) =>
    member.worktreePath === null ? [] : [[member.requestedName, member.worktreePath] as const],
  )
  return (
    actual.size === bindings.length &&
    actual.size === expected.length &&
    expected.every(([requestedName, path]) => actual.get(requestedName) === path)
  )
}
