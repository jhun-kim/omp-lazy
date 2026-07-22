import { mkdir, readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { atomicCreate } from "./atomic-file"
import { decodeStateEvent } from "./codec"
import type { PersistedStateEvent } from "./domain"
import type { StatePathGuard } from "./paths"
import type { Deadline } from "./repo-lock"

const EVENT_FILE = /^(\d{16})-([0-9a-f-]{36})\.json$/

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

export class EventStoreError extends Error {
  readonly name = "EventStoreError"
  constructor(
    readonly code:
      | "invalid_event_filename"
      | "malformed_event"
      | "event_filename_mismatch"
      | "event_sequence_gap",
  ) {
    super(code)
  }
}

export class EventStore {
  readonly eventsPath: string

  constructor(
    readonly stateRoot: string,
    readonly guard?: StatePathGuard,
  ) {
    this.eventsPath = join(stateRoot, "events")
  }

  eventPath(event: PersistedStateEvent): string {
    const sequence = event.sequence.toString().padStart(16, "0")
    return join(this.eventsPath, `${sequence}-${event.eventId}.json`)
  }

  async append(event: PersistedStateEvent, deadline: Deadline): Promise<void> {
    if (event.sequence < 1) throw new EventStoreError("event_sequence_gap")
    const path = this.eventPath(event)
    await this.guard?.(path)
    await mkdir(this.eventsPath, { recursive: true })
    await atomicCreate(path, JSON.stringify(event), {
      deadline,
      ...(this.guard === undefined ? {} : { guard: this.guard }),
    })
  }

  async readAll(): Promise<readonly PersistedStateEvent[]> {
    await this.guard?.(this.eventsPath)
    let names: readonly string[]
    try {
      names = await readdir(this.eventsPath)
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
    const committed = names.filter((name) => !name.includes(".tmp-"))
    const events: PersistedStateEvent[] = []
    for (const name of committed) {
      const match = EVENT_FILE.exec(name)
      if (match === null) throw new EventStoreError("invalid_event_filename")
      const sequenceText = match[1]
      const eventId = match[2]
      if (sequenceText === undefined || eventId === undefined) {
        throw new EventStoreError("invalid_event_filename")
      }
      const path = join(this.eventsPath, name)
      await this.guard?.(path)
      const decoded = decodeStateEvent(await readFile(path, "utf8"))
      if (!decoded.ok) throw new EventStoreError("malformed_event")
      const event = decoded.value
      if (event.sequence !== Number(sequenceText) || event.eventId !== eventId) {
        throw new EventStoreError("event_filename_mismatch")
      }
      events.push(event)
    }
    events.sort((left, right) => left.sequence - right.sequence)
    for (const [index, event] of events.entries()) {
      if (event.sequence !== index + 1) throw new EventStoreError("event_sequence_gap")
    }
    return events
  }
}
