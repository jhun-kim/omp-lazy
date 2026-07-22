import { describe, expect, test } from "bun:test"
import { CriticReceiptSchema, validateCriticReceipt } from "../../src/contracts/critic-receipt"

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
  })
}

const expected = {
  actor: "omp-lazy-reviewer",
  packetHash: "a".repeat(64),
  head: "b".repeat(40),
  generation: 1,
  receiptId: "critic-1",
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
})
