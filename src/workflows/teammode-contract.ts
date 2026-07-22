import { realpath } from "node:fs/promises"
import { WorkerAcceptanceLedger } from "../contracts/worker-acceptance-ledger"
import type { TaskEventLedger } from "../gates/task-event-ledger"
import { taskGeneration } from "../gates/task-ledger-view"
import { deadlineAfter } from "../state/repo-lock"
import { checkWorkingDirectory } from "../state/repo-root"
import {
  matchesTeamDefinition,
  matchesTeamWorktreeBindings,
  type TeamCaller,
  TeamDefinitionSchema,
  TeamNameSchema,
  type TeamResult,
  type TeamState,
  TeamStateSchema,
  type TeamWorktreeBinding,
} from "./teammode-domain"
import { TeammodeStateStore } from "./teammode-state-store"
import { validateTeamWorktree } from "./teammode-worktree"

export type { TeamCaller, TeamDefinition, TeamResult, TeamState } from "./teammode-domain"
export { TeamDefinitionSchema } from "./teammode-domain"

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export class TeammodeContract {
  readonly acceptance: WorkerAcceptanceLedger
  readonly states: TeammodeStateStore

  constructor(readonly taskLedger: TaskEventLedger) {
    this.acceptance = new WorkerAcceptanceLedger(taskLedger.store)
    this.states = new TeammodeStateStore(taskLedger.store)
  }

  async initialize(caller: TeamCaller, input: unknown): Promise<TeamResult> {
    const parsed = TeamDefinitionSchema.safeParse(input)
    if (!parsed.success) return { ok: false, code: "invalid_team" }
    if (!["task", "hub"].every((tool) => caller.toolNames.includes(tool))) {
      return { ok: false, code: "async_team_surfaces_unavailable" }
    }
    return this.#transact(caller, parsed.data.teamName, async (current, scope) => {
      if (current !== null) {
        const sameScope =
          current.runId === scope.run.runId && current.attempt === scope.run.progressRevision
        return sameScope && matchesTeamDefinition(current, parsed.data)
          ? { ok: true, status: "replayed", state: current }
          : { ok: false, code: "team_conflict" }
      }
      const candidate: TeamState = TeamStateSchema.parse({
        schemaVersion: 1,
        teamName: parsed.data.teamName,
        runId: scope.run.runId,
        attempt: scope.run.progressRevision,
        revision: 1,
        status: "initializing",
        members: parsed.data.members.map((member) => ({
          ...member,
          actualAgentId: null,
          actualJobId: null,
          worktreePath: null,
          acceptanceKey: null,
        })),
      })
      return { ok: true, status: "created", state: candidate }
    })
  }

  async bind(
    caller: TeamCaller,
    teamName: string,
    worktrees: readonly TeamWorktreeBinding[] = [],
  ): Promise<TeamResult> {
    return this.#transact(caller, teamName, async (current) => {
      if (current === null) return { ok: false, code: "team_missing" }
      if (current.status !== "initializing") {
        if (current.status !== "active") return { ok: false, code: "invalid_team_state" }
        const canonicalWorktrees = (
          await Promise.all(
            worktrees.map(async (binding) => {
              try {
                return [{ ...binding, path: await realpath(binding.path) }]
              } catch (error) {
                if (error instanceof Error) return []
                throw error
              }
            }),
          )
        ).flat()
        return canonicalWorktrees.length === worktrees.length &&
          matchesTeamWorktreeBindings(current, canonicalWorktrees)
          ? { ok: true, status: "replayed", state: current }
          : { ok: false, code: "team_bind_conflict" }
      }
      const capability = await this.taskLedger.capability(caller.sessionId)
      if (capability.status !== "proven") return { ok: false, code: "async_capability_unproven" }
      const identities = await this.taskLedger.identities(caller.sessionId)
      if (identities.length !== current.members.length)
        return { ok: false, code: "identity_mapping_incomplete" }
      const actualIds = new Set(identities.map((identity) => identity.actualAgentId))
      if (actualIds.size !== identities.length)
        return { ok: false, code: "identity_mapping_incomplete" }
      const bindingMap = new Map(worktrees.map((binding) => [binding.requestedName, binding.path]))
      if (
        bindingMap.size !== worktrees.length ||
        [...bindingMap.keys()].some(
          (key) => !current.members.some((member) => member.requestedName === key),
        )
      )
        return { ok: false, code: "invalid_worktree_binding" }
      const members: TeamState["members"][number][] = []
      for (const member of current.members) {
        const matches = identities.filter(
          (identity) =>
            identity.requestedName === member.requestedName &&
            identity.agentType === member.agentType,
        )
        if (matches.length !== 1) return { ok: false, code: "identity_mapping_incomplete" }
        const identity = matches[0]
        if (identity === undefined) return { ok: false, code: "identity_mapping_incomplete" }
        const worktree = bindingMap.get(member.requestedName)
        let worktreePath: string | null = null
        if (worktree !== undefined) {
          const validated = await validateTeamWorktree(
            this.taskLedger.store.root.displayPath,
            worktree,
          )
          if (!validated.ok) return { ok: false, code: validated.code }
          worktreePath = validated.path
        }
        members.push({
          ...member,
          actualAgentId: identity.actualAgentId,
          actualJobId: identity.actualJobId,
          worktreePath,
        })
      }
      const state = TeamStateSchema.parse({
        ...current,
        revision: current.revision + 1,
        status: "active",
        members,
      })
      return { ok: true, status: "bound", state }
    })
  }

  async complete(caller: TeamCaller, teamName: string): Promise<TeamResult> {
    return this.#transact(caller, teamName, async (current, scope) => {
      if (current === null) return { ok: false, code: "team_missing" }
      if (current.status === "completed") return { ok: true, status: "replayed", state: current }
      if (
        current.status !== "active" ||
        current.runId !== scope.run.runId ||
        current.attempt !== scope.run.progressRevision
      )
        return { ok: false, code: "invalid_team_state" }
      const entries = await this.acceptance.entries(current.runId)
      const generation = taskGeneration(scope)
      const members = current.members.map((member) => {
        const entry = entries.find(
          (candidate) =>
            candidate.attempt === current.attempt &&
            candidate.runRevision === scope.run.revision &&
            candidate.ownerSessionId === scope.run.owner.sessionId &&
            candidate.ownerEpoch === scope.run.owner.epoch &&
            candidate.taskGeneration === generation &&
            candidate.actualAgentId === member.actualAgentId &&
            candidate.actualJobId === member.actualJobId &&
            candidate.workerRole === member.agentType,
        )
        return entry === undefined ? null : { ...member, acceptanceKey: entry.idempotencyKey }
      })
      if (members.some((member) => member === null))
        return { ok: false, code: "parent_acceptance_incomplete" }
      const state = TeamStateSchema.parse({
        ...current,
        revision: current.revision + 1,
        status: "completed",
        members,
      })
      return { ok: true, status: "completed", state }
    })
  }

  async archive(caller: TeamCaller, teamName: string): Promise<TeamResult> {
    return this.#transact(caller, teamName, async (current) => {
      if (current === null) return { ok: false, code: "team_missing" }
      if (current.status === "archived")
        return { ok: true, status: "replayed", state: current, runtimeAgentsArchived: false }
      if (current.status !== "completed" && current.status !== "cancelled") {
        return { ok: false, code: "team_not_completed" }
      }
      const state = TeamStateSchema.parse({
        ...current,
        revision: current.revision + 1,
        status: "archived",
      })
      return { ok: true, status: "archived", state, runtimeAgentsArchived: false }
    })
  }

  async cancel(caller: TeamCaller, teamName: string): Promise<TeamResult> {
    return this.#transact(caller, teamName, async (current) => {
      if (current === null) return { ok: false, code: "team_missing" }
      if (current.status === "cancelled") return { ok: true, status: "replayed", state: current }
      if (current.status !== "initializing" && current.status !== "active") {
        return { ok: false, code: "invalid_team_state" }
      }
      const state = TeamStateSchema.parse({
        ...current,
        revision: current.revision + 1,
        status: "cancelled",
      })
      return { ok: true, status: "cancelled", state }
    })
  }

  async resume(caller: TeamCaller, teamName: string): Promise<TeamResult> {
    return this.#transact(caller, teamName, async (current) => {
      if (current === null) return { ok: false, code: "team_missing" }
      if (current.status !== "cancelled") return { ok: false, code: "invalid_team_state" }
      const state = TeamStateSchema.parse({
        ...current,
        revision: current.revision + 1,
        status: "initializing",
        members: current.members.map((member) => ({
          ...member,
          actualAgentId: null,
          actualJobId: null,
          worktreePath: null,
          acceptanceKey: null,
        })),
      })
      return { ok: true, status: "resumed", state }
    })
  }

  async delete(caller: TeamCaller, teamName: string): Promise<TeamResult> {
    return this.#transact(caller, teamName, async (current) =>
      current?.status === "archived"
        ? { ok: true, status: "deleted" }
        : { ok: false, code: current === null ? "team_missing" : "team_not_archived" },
    )
  }

  async read(teamName: string): Promise<TeamState | null> {
    return this.states.read(teamName)
  }

  async #transact(
    caller: TeamCaller,
    teamName: string,
    decide: (
      state: TeamState | null,
      scope: Extract<Awaited<ReturnType<TaskEventLedger["resolve"]>>, { kind: "scope" }>["value"],
    ) => Promise<TeamResult>,
  ): Promise<TeamResult> {
    if (!TeamNameSchema.safeParse(teamName).success) return { ok: false, code: "invalid_team_name" }
    const cwd = await checkWorkingDirectory(this.taskLedger.store.root, caller.cwd)
    if (!cwd.ok) return { ok: false, code: "cwd_mismatch" }
    const deadline = deadlineAfter(2_000)
    const handle = await this.taskLedger.store.lock.tryAcquire({
      deadline,
      purpose: "command",
      sessionId: caller.sessionId,
      maxWaitMs: Math.min(2_000, deadline.remainingMs()),
    })
    if (handle === null) return { ok: false, code: "state_conflict" }
    try {
      const scope = await this.taskLedger.resolve(caller.sessionId)
      if (scope.kind !== "scope") return { ok: false, code: "caller_not_current_parent" }
      const current = await this.read(teamName)
      const result = await decide(current, scope.value)
      if (!result.ok) return result
      if (result.status === "deleted") await this.states.remove(teamName, deadline)
      else if (result.state !== undefined && !same(result.state, current))
        await this.states.replace(teamName, result.state, deadline)
      return result
    } finally {
      await handle.release()
    }
  }
}
