import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AgentIdSchema, JobIdSchema } from "../../src/contracts/agent-ids"
import { UuidSchema } from "../../src/state/domain"
import type {
  AcceptanceRuntime,
  EvidenceFiles,
  ReceiptOverrides,
} from "./worker-acceptance-fixtures"

export const ARTIFACT_FILE_CASES: readonly [
  string,
  (value: AcceptanceRuntime, files: EvidenceFiles) => Promise<string>,
  string,
][] = [
  [
    "missing",
    async (_value, files) => {
      await rm(files.artifactPath)
      return files.receiptPath
    },
    "invalid_artifact",
  ],
  [
    "empty",
    async (_value, files) => {
      await writeFile(files.artifactPath, "")
      return files.receiptPath
    },
    "invalid_artifact",
  ],
  [
    "directory",
    async (_value, files) => {
      await rm(files.artifactPath)
      await mkdir(files.artifactPath)
      return files.receiptPath
    },
    "invalid_artifact",
  ],
  ["missing receipt", async () => "missing-receipt.json", "invalid_receipt_file"],
  [
    "malformed receipt",
    async (_value, files) => {
      await writeFile(join(files.artifactPath, "..", "receipt.json"), "{")
      return files.receiptPath
    },
    "malformed_receipt",
  ],
]

export const RECEIPT_BINDING_CASES: readonly [
  string,
  (value: AcceptanceRuntime) => ReceiptOverrides,
  string,
][] = [
  ["role", () => ({ workerRole: "omp-lazy-worker-high" }), "wrong_worker_role"],
  ["agent", () => ({ actualAgentId: AgentIdSchema.parse("forged-worker") }), "wrong_agent_id"],
  ["job", () => ({ actualJobId: JobIdSchema.parse("forged-job") }), "wrong_job_id"],
  ["run", () => ({ runId: UuidSchema.parse("99999999-9999-4999-8999-999999999999") }), "wrong_run"],
  ["attempt", (value) => ({ attempt: value.run.progressRevision + 1 }), "wrong_attempt"],
  ["revision", (value) => ({ runRevision: value.run.revision + 1 }), "wrong_revision"],
  ["owner epoch", (value) => ({ ownerEpoch: value.run.owner.epoch + 1 }), "wrong_owner_epoch"],
  ["generation", () => ({ taskGeneration: 1 }), "wrong_task_generation"],
  ["commit", () => ({ captureCommit: "b".repeat(40) }), "wrong_capture_commit"],
  [
    "artifact attempt",
    (value) => ({ artifactCaptureAttempt: value.run.progressRevision + 1 }),
    "stale_artifact_metadata",
  ],
]

export const OUTPUT_BINDING_CASES = [
  ["truncated", { truncated: true }, "truncated_output"],
  ["nonzero", { exitCode: 7 }, "nonzero_output"],
  ["schema override", { schemaOverridden: true }, "schema_overridden_output"],
  ["aborted", { aborted: true }, "aborted_output"],
  ["blocked", { blocked: true }, "blocked_output"],
] as const
