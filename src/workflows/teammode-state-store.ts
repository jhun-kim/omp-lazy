import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { atomicReplace } from "../state/atomic-file"
import type { Deadline } from "../state/repo-lock"
import type { TransactionStore } from "../state/transaction-store"
import { TeamNameSchema, type TeamState, TeamStateSchema } from "./teammode-domain"

const teamTombstoneSchema = z.discriminatedUnion("schemaVersion", [
  z.strictObject({
    deleted: z.literal(true),
    schemaVersion: z.literal(1),
    teamName: TeamNameSchema,
  }),
  z.strictObject({
    deleted: z.literal(true),
    schemaVersion: z.literal(2),
    teamName: TeamNameSchema,
  }),
])

const persistedTeamStateSchema = z.preprocess((value) => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 2
  ) {
    return value
  }
  const status = "status" in value ? value.status : undefined
  return {
    ...value,
    schemaVersion: 1,
    status: status === "bound" ? "active" : status,
  }
}, TeamStateSchema)

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

export class TeammodeStateStore {
  constructor(readonly store: TransactionStore) {}

  async read(teamName: string): Promise<TeamState | null> {
    const path = this.#path(teamName)
    await this.store.guard(path)
    try {
      const raw: unknown = JSON.parse(await readFile(path, "utf8"))
      if (teamTombstoneSchema.safeParse(raw).success) return null
      return persistedTeamStateSchema.parse(raw)
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  async remove(teamName: string, deadline: Deadline): Promise<void> {
    const schemaVersion = (await this.store.readIndex(false)).schemaVersion
    await atomicReplace(
      this.#path(teamName),
      JSON.stringify(teamTombstoneSchema.parse({ deleted: true, schemaVersion, teamName })),
      { deadline, guard: this.store.guard },
    )
  }

  async replace(teamName: string, state: TeamState, deadline: Deadline): Promise<void> {
    const schemaVersion = (await this.store.readIndex(false)).schemaVersion
    const persisted =
      schemaVersion === 2
        ? { ...state, schemaVersion, status: state.status === "active" ? "bound" : state.status }
        : state
    await atomicReplace(this.#path(teamName), JSON.stringify(persisted), {
      deadline,
      guard: this.store.guard,
    })
  }

  #path(teamName: string): string {
    return join(this.store.paths.root, "teams", `${teamName}.json`)
  }
}
