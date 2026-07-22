import {
  type CriticReceiptBinding,
  CriticReceiptSchema,
  type VerifierEvidence,
  VerifierEvidenceSchema,
} from "../../src/contracts/critic-receipt"
import type { TaskPacketInput } from "../../src/contracts/task-packet"

export const packetHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
export const head = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
export const provenanceSha256 = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
export const contentSha256 = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
export const changedContentSha256 =
  "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"

export function validReceipt() {
  return CriticReceiptSchema.parse({
    version: 1,
    kind: "omp_lazy_critic_receipt",
    verdict: "APPROVE",
    actor: "omp-lazy-reviewer",
    packetHash,
    head,
    generation: 1,
    receiptId: "critic-1",
    hardGates: [{ id: "scope", passed: true }],
    evidenceLogicalIds: ["T04.packet"],
  })
}

export function authorization(
  id: string,
  evidenceLogicalId: string,
  hashValue = contentSha256,
): VerifierEvidence["authorizations"][number] {
  return { id, evidenceLogicalId, passed: true, provenanceSha256, contentSha256: hashValue }
}

export function validVerifierEvidence() {
  return VerifierEvidenceSchema.parse({
    actor: "omp-lazy-verifier",
    packetHash,
    head,
    generation: 1,
    authorizations: [authorization("scope", "T04.packet")],
  })
}

export const expected: CriticReceiptBinding = {
  actor: "omp-lazy-reviewer",
  verifierActor: "omp-lazy-verifier",
  packetHash,
  head,
  generation: 1,
  receiptId: "critic-1",
  requiredHardGateIds: ["scope"],
  requiredEvidenceLogicalIds: ["T04.packet"],
  requiredGateEvidence: [{ id: "scope", evidenceLogicalId: "T04.packet" }],
}

export function buildCompiledPacketInput(): TaskPacketInput {
  return {
    version: 1,
    runId: "run-1",
    taskId: "T04",
    generation: 2,
    objective: "Critic contract",
    deliverable: "A receipt binding",
    allowedPaths: ["src/contracts/critic-receipt.ts"],
    referenceIds: [],
    dependencyIds: [],
    criteria: [
      {
        id: "gate-z",
        scenario: "valid receipt",
        observable: "z gate is bound",
        expected: "pass",
        evidenceLogicalId: "evidence-z",
      },
      {
        id: "gate-A",
        scenario: "valid receipt",
        observable: "A gate is bound",
        expected: "pass",
        evidenceLogicalId: "evidence-A",
      },
    ],
    boundaryTags: ["none"],
    publicBehavior: false,
    tier: "FAST",
    budgets: {
      maxCalls: 3,
      maxPacketBytes: 4096,
      maxRetrievalCalls: 4,
      maxRetrievalBytes: 16384,
    },
    evidenceRequirements: [
      { logicalId: "evidence-z", kind: "test", required: true },
      { logicalId: "evidence-A", kind: "artifact", required: true },
      { logicalId: "optional", kind: "citation", required: false },
    ],
  }
}
