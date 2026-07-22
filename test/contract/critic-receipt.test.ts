import { describe, expect, test } from "bun:test"
import {
  bindCriticReceiptToPacket,
  CriticReceiptSchema,
  VerifierEvidenceSchema,
  validateCriticReceipt,
} from "../../src/contracts/critic-receipt"
import { compileTaskPacket } from "../../src/contracts/task-packet"
import {
  authorization,
  buildCompiledPacketInput,
  changedContentSha256,
  expected,
  head,
  provenanceSha256,
  validReceipt,
  validVerifierEvidence,
} from "./critic-receipt-fixtures"

describe("critic receipt contract", () => {
  test("Given a fully self-attested all-green APPROVE receipt When no verifier evidence is supplied Then it is rejected", () => {
    // Given
    const receipt = validReceipt()

    // When
    const result = validateCriticReceipt(expected, receipt, undefined)

    // Then
    expect(result).toEqual({ ok: false, code: "malformed_verifier_evidence" })
  })

  test("Given a matching APPROVE receipt and separately bound verifier evidence When validated Then it is accepted", () => {
    // Given
    const receipt = validReceipt()
    const verifierEvidence = validVerifierEvidence()

    // When
    const result = validateCriticReceipt(expected, receipt, verifierEvidence)

    // Then
    expect(result).toEqual({ ok: true, receipt })
  })

  test("Given an all-green artifact from an unexpected verifier actor When validated Then it is rejected", () => {
    // Given
    const verifierEvidence = { ...validVerifierEvidence(), actor: "omp-lazy-unexpected-verifier" }

    // When
    const result = validateCriticReceipt(expected, validReceipt(), verifierEvidence)

    // Then
    expect(result).toEqual({ ok: false, code: "wrong_verifier_actor" })
  })

  test("Given an APPROVE receipt with a failed hard gate When validated Then a score cannot override it", () => {
    // Given
    const receipt = {
      ...validReceipt(),
      hardGates: [{ id: "scope", passed: false }],
      qualityScore: { version: 1, score: 100, hardGatePassed: true },
    }

    // When
    const result = validateCriticReceipt(expected, receipt, validVerifierEvidence())

    // Then
    expect(result).toEqual({ ok: false, code: "hard_gate_failed" })
  })

  test("Given a green critic claim and an invalid verifier authorization or actor When validated Then it is rejected", () => {
    // Given
    const verifierEvidence = {
      ...validVerifierEvidence(),
      authorizations: validVerifierEvidence().authorizations.map((authorization) => ({
        ...authorization,
        passed: false,
      })),
    }

    // When
    const results = [
      validateCriticReceipt(expected, validReceipt(), verifierEvidence),
      validateCriticReceipt(expected, validReceipt(), {
        ...validVerifierEvidence(),
        actor: "omp-lazy-reviewer",
      }),
    ]

    // Then
    expect(results).toEqual([
      { ok: false, code: "hard_gate_failed" },
      { ok: false, code: "wrong_verifier_actor" },
    ])
  })

  test("Given stale packet, head, or generation bindings When validated Then each receipt is rejected", () => {
    // Given
    const packet = { ...validReceipt(), packetHash: "c".repeat(64) }
    const head = { ...validReceipt(), head: "c".repeat(40) }
    const generation = { ...validReceipt(), generation: 2 }

    // When
    const results = [
      validateCriticReceipt(expected, packet, validVerifierEvidence()),
      validateCriticReceipt(expected, head, validVerifierEvidence()),
      validateCriticReceipt(expected, generation, validVerifierEvidence()),
    ]

    // Then
    expect(results).toEqual([
      { ok: false, code: "stale_packet" },
      { ok: false, code: "wrong_head" },
      { ok: false, code: "wrong_generation" },
    ])
  })

  test("Given stale verifier packet, head, or generation bindings When validated Then each artifact is rejected", () => {
    // Given
    const verifierEvidence = validVerifierEvidence()

    // When
    const results = [
      validateCriticReceipt(expected, validReceipt(), {
        ...verifierEvidence,
        packetHash: provenanceSha256,
      }),
      validateCriticReceipt(expected, validReceipt(), {
        ...verifierEvidence,
        head: head.replaceAll("b", "c"),
      }),
      validateCriticReceipt(expected, validReceipt(), { ...verifierEvidence, generation: 2 }),
    ]

    // Then
    expect(results).toEqual([
      { ok: false, code: "stale_packet" },
      { ok: false, code: "wrong_head" },
      { ok: false, code: "wrong_generation" },
    ])
  })

  test("Given repeated logical evidence with changed hashes When validated Then it is rejected", () => {
    // Given
    const repeatedExpected = {
      ...expected,
      requiredHardGateIds: ["gate-A", "gate-z"],
      requiredEvidenceLogicalIds: ["evidence-shared"],
      requiredGateEvidence: [
        { id: "gate-A", evidenceLogicalId: "evidence-shared" },
        { id: "gate-z", evidenceLogicalId: "evidence-shared" },
      ],
    }
    const receipt = {
      ...validReceipt(),
      hardGates: [
        { id: "gate-A", passed: true },
        { id: "gate-z", passed: true },
      ],
      evidenceLogicalIds: ["evidence-shared"],
    }
    const verifierEvidence = {
      ...validVerifierEvidence(),
      authorizations: [
        authorization("gate-A", "evidence-shared"),
        authorization("gate-z", "evidence-shared", changedContentSha256),
      ],
    }

    // When
    const result = validateCriticReceipt(repeatedExpected, receipt, verifierEvidence)

    // Then
    expect(result).toEqual({ ok: false, code: "inconsistent_verifier_evidence_hashes" })
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
      validateCriticReceipt(expected, omittedGate, validVerifierEvidence()),
      validateCriticReceipt(expected, omittedEvidence, validVerifierEvidence()),
      validateCriticReceipt(expected, extraGate, validVerifierEvidence()),
      validateCriticReceipt(expected, extraEvidence, validVerifierEvidence()),
    ]

    // Then
    expect(results).toEqual([
      { ok: false, code: "required_hard_gates_mismatch" },
      { ok: false, code: "required_evidence_mismatch" },
      { ok: false, code: "required_hard_gates_mismatch" },
      { ok: false, code: "required_evidence_mismatch" },
    ])
  })

  test("Given a compiled packet with optional evidence When bound verifier evidence is validated Then required pairs pass and swapped pairs reject", () => {
    // Given
    const packet = compileTaskPacket(buildCompiledPacketInput())
    expect(packet).toMatchObject({ ok: true })
    if (!packet.ok) return

    // When
    const binding = bindCriticReceiptToPacket({
      actor: "omp-lazy-reviewer",
      verifierActor: "omp-lazy-verifier",
      head: "b".repeat(40),
      receiptId: "critic-2",
      packet,
    })

    // Then
    expect(binding.requiredHardGateIds).toEqual(["gate-A", "gate-z"])
    expect(binding.verifierActor).toBe("omp-lazy-verifier")
    expect(binding.requiredEvidenceLogicalIds).toEqual(["evidence-A", "evidence-z"])
    expect(binding.requiredGateEvidence).toEqual([
      { id: "gate-A", evidenceLogicalId: "evidence-A" },
      { id: "gate-z", evidenceLogicalId: "evidence-z" },
    ])
    const receipt = CriticReceiptSchema.parse({
      ...validReceipt(),
      packetHash: binding.packetHash,
      head: binding.head,
      generation: binding.generation,
      receiptId: binding.receiptId,
      hardGates: [
        { id: "gate-A", passed: true },
        { id: "gate-z", passed: true },
      ],
      evidenceLogicalIds: ["evidence-A", "evidence-z"],
    })
    const verifierEvidence = VerifierEvidenceSchema.parse({
      actor: "omp-lazy-verifier",
      packetHash: binding.packetHash,
      head: binding.head,
      generation: binding.generation,
      authorizations: [
        authorization("gate-A", "evidence-A"),
        authorization("gate-z", "evidence-z"),
      ],
    })
    expect(validateCriticReceipt(binding, receipt, verifierEvidence)).toEqual({ ok: true, receipt })
    expect(
      validateCriticReceipt(binding, receipt, {
        ...verifierEvidence,
        authorizations: [
          authorization("gate-A", "evidence-z"),
          authorization("gate-z", "evidence-A"),
        ],
      }),
    ).toEqual({ ok: false, code: "verifier_authorizations_mismatch" })
  })
})
