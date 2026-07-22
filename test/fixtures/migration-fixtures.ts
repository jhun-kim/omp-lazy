import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { CanonicalRoot } from "../../src/state/domain"
import { statePaths } from "../../src/state/paths"
import { initializedStore } from "./store-fixtures"

const WORKER_ROLE = "omp-lazy-worker-medium"
const WORKER_ID = "migration-worker-a"

export type DurableMigrationFixture = {
  readonly root: CanonicalRoot
  readonly paths: ReturnType<typeof statePaths>
  readonly durablePaths: readonly string[]
}

export async function writeDurableV1State(root: CanonicalRoot): Promise<DurableMigrationFixture> {
  const { run } = await initializedStore(root)
  const paths = statePaths(root)
  const acceptanceEntry = {
    sequence: 1,
    idempotencyKey: "migration-acceptance",
    runId: run.runId,
    attempt: 1,
    runRevision: run.revision,
    ownerSessionId: run.owner.sessionId,
    ownerEpoch: run.owner.epoch,
    taskGeneration: 1,
    workerRole: WORKER_ROLE,
    actualAgentId: WORKER_ID,
    actualJobId: null,
    captureCommit: "a".repeat(40),
    receiptPath: ".omo/evidence/receipt.json",
    receiptHash: "b".repeat(64),
    artifactHash: "c".repeat(64),
    artifactPaths: [".omo/evidence/result.txt"],
    cleanupReceiptPaths: [".omo/evidence/cleanup.json"],
  }
  const taskFactsPath = join(paths.root, "task-facts", `${run.runId}.json`)
  const acceptancePath = join(paths.root, "worker-acceptance", `${run.runId}.json`)
  const walPath = join(paths.root, "worker-acceptance", `${run.runId}.wal.jsonl`)
  const rejectionPath = join(paths.root, "worker-rejections", `${run.runId}.json`)
  const teamPath = join(paths.root, "teams", "alpha.json")
  await Promise.all([
    mkdir(join(paths.root, "task-facts"), { recursive: true }),
    mkdir(join(paths.root, "worker-acceptance"), { recursive: true }),
    mkdir(join(paths.root, "worker-rejections"), { recursive: true }),
    mkdir(join(paths.root, "teams"), { recursive: true }),
  ])
  await writeFile(
    taskFactsPath,
    JSON.stringify({
      schemaVersion: 1,
      runId: run.runId,
      ledgerRevision: 2,
      entries: [
        {
          sequence: 1,
          ownerSessionId: run.owner.sessionId,
          ownerEpoch: run.owner.epoch,
          fact: {
            kind: "task_reserved",
            toolCallId: "migration-dispatch",
            itemCount: 1,
            requests: [{ itemIndex: 0, requestedName: "TASK-ALPHA", agentType: WORKER_ROLE }],
          },
        },
        {
          sequence: 2,
          ownerSessionId: run.owner.sessionId,
          ownerEpoch: run.owner.epoch,
          fact: {
            kind: "task_identities_bound",
            toolCallId: "migration-dispatch",
            bindings: [{ itemIndex: 0, actualAgentId: WORKER_ID, actualJobId: null }],
          },
        },
      ],
    }),
  )
  await writeFile(
    acceptancePath,
    JSON.stringify({
      schemaVersion: 1,
      runId: run.runId,
      ledgerRevision: 1,
      entries: [acceptanceEntry],
    }),
  )
  await writeFile(walPath, `${JSON.stringify(acceptanceEntry)}\n`)
  await writeFile(
    rejectionPath,
    JSON.stringify({
      schemaVersion: 1,
      runId: run.runId,
      entries: [
        {
          runId: run.runId,
          attempt: 1,
          runRevision: run.revision,
          ownerEpoch: run.owner.epoch,
          taskGeneration: 1,
          actualAgentId: WORKER_ID,
          count: 2,
          status: "retry_allowed",
        },
      ],
    }),
  )
  await writeFile(
    teamPath,
    JSON.stringify({
      schemaVersion: 1,
      teamName: "alpha",
      runId: run.runId,
      attempt: 1,
      revision: 1,
      status: "active",
      members: [
        {
          requestedName: "alpha-one",
          agentType: "omp-lazy-worker-low",
          focus: "first migration worker",
          ownership: ["src/one"],
          deliverable: "first durable result",
          isolated: false,
          actualAgentId: "alpha-agent-one",
          actualJobId: "alpha-job-one",
          worktreePath: null,
          acceptanceKey: null,
        },
        {
          requestedName: "alpha-two",
          agentType: "omp-lazy-worker-high",
          focus: "second migration worker",
          ownership: ["src/two"],
          deliverable: "second durable result",
          isolated: false,
          actualAgentId: "alpha-agent-two",
          actualJobId: "alpha-job-two",
          worktreePath: null,
          acceptanceKey: null,
        },
      ],
    }),
  )
  return {
    root,
    paths,
    durablePaths: [
      "active.json",
      `runs/${run.runId}/run.json`,
      "events/0000000000000001-55555555-5555-4555-8555-555555555555.json",
      `task-facts/${run.runId}.json`,
      `worker-acceptance/${run.runId}.json`,
      `worker-acceptance/${run.runId}.wal.jsonl`,
      `worker-rejections/${run.runId}.json`,
      "teams/alpha.json",
    ],
  }
}

export async function durableStateVersions(
  fixture: DurableMigrationFixture,
): Promise<readonly number[]> {
  return Promise.all(
    fixture.durablePaths.map(async (path) => {
      const bytes = await readFile(join(fixture.paths.root, path), "utf8")
      const json = path.endsWith(".jsonl")
        ? bytes
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [JSON.parse(bytes)]
      return json.map((value) => value.schemaVersion).every((version) => version === 2) ? 2 : 1
    }),
  )
}
