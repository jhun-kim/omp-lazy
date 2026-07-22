import { describe, expect, test } from "bun:test"
import {
  bindCriticReceiptToPacket,
  CriticReceiptSchema,
  validateCriticReceipt,
} from "../../src/contracts/critic-receipt"
import { compileTaskPacket } from "../../src/contracts/task-packet"

function validReceipt() {
  return CriticReceiptSchema.parse({
    version: 1,
    kind: "omp_lazy_critic_receipt",
    verdict: "APPROVE",
    actor: "omp-lazy-reviewer",
    packetHash: "a".repeat(64),
    head: "b".repeat(40),
    generation: 1,
    receiptId: "critic-1",
    hardGates: [{ id: "scope", passed: true }],
    evidenceLogicalIds: ["T04.packet"],
  })
}

const expected = {
  actor: "omp-lazy-reviewer",
  packetHash: "a".repeat(64),
  head: "b".repeat(40),
  generation: 1,
  receiptId: "critic-1",
  requiredHardGateIds: ["scope"],
  requiredEvidenceLogicalIds: ["T04.packet"],
}

describe("critic receipt contract", () => {
  test("Given a matching uppercase APPROVE receipt When validated Then it is accepted", () => {
    // Given
    const receipt = validReceipt()

    // When
    const result = validateCriticReceipt(expected, receipt)

    // Then
    expect(result).toEqual({ ok: true, receipt })
  })

  test("Given an APPROVE receipt with a failed hard gate When validated Then a score cannot override it", () => {
    // Given
    const receipt = {
      ...validReceipt(),
      hardGates: [{ id: "scope", passed: false }],
      qualityScore: { version: 1, score: 100, hardGatePassed: true },
    }

    // When
    const result = validateCriticReceipt(expected, receipt)

    // Then
    expect(result).toEqual({ ok: false, code: "hard_gate_failed" })
  })

  test("Given stale packet, head, or generation bindings When validated Then each receipt is rejected", () => {
    // Given
    const packet = { ...validReceipt(), packetHash: "c".repeat(64) }
    const head = { ...validReceipt(), head: "c".repeat(40) }
    const generation = { ...validReceipt(), generation: 2 }

    // When
    const results = [
      validateCriticReceipt(expected, packet),
      validateCriticReceipt(expected, head),
      validateCriticReceipt(expected, generation),
    ]

    // Then
    expect(results).toEqual([
      { ok: false, code: "stale_packet" },
      { ok: false, code: "wrong_head" },
      { ok: false, code: "wrong_generation" },
    ])
  })

  test("Given an APPROVE receipt omitting issued hard gates or required evidence When validated Then it is rejected", () => {
    // Given
    const omittedGate = { ...validReceipt(), hardGates: [{ id: "other", passed: true }] }
    const omittedEvidence = { ...validReceipt(), evidenceLogicalIds: ["T04.other"] }
    const extraGate = {
      ...validReceipt(),
      hardGates: [
        { id: "scope", passed: true },
        { id: "unissued", passed: true },
      ],
    }
    const extraEvidence = {
      ...validReceipt(),
      evidenceLogicalIds: ["T04.packet", "T04.unissued"],
    }

    // When
    const results = [
      validateCriticReceipt(expected, omittedGate),
      validateCriticReceipt(expected, omittedEvidence),
      validateCriticReceipt(expected, extraGate),
      validateCriticReceipt(expected, extraEvidence),
    ]

    // Then
    expect(results).toEqual([
      { ok: false, code: "required_hard_gates_mismatch" },
      { ok: false, code: "required_evidence_mismatch" },
      { ok: false, code: "required_hard_gates_mismatch" },
      { ok: false, code: "required_evidence_mismatch" },
    ])
  })

  test("Given a compiled packet When a critic binding is issued Then criterion gates and required evidence are ordinally sorted", () => {
    // Given
    const packet = compileTaskPacket({
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
    })
    expect(packet).toMatchObject({ ok: true })
    if (!packet.ok) return

    // When
    const binding = bindCriticReceiptToPacket({
      actor: "omp-lazy-reviewer",
      head: "b".repeat(40),
      receiptId: "critic-2",
      packet,
    })

    // Then
    expect(binding.requiredHardGateIds).toEqual(["gate-A", "gate-z"])
    expect(binding.requiredEvidenceLogicalIds).toEqual(["evidence-A", "evidence-z"])
  })
})
