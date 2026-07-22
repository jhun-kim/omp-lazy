import { describe, expect, test } from "bun:test"
import { compileTaskPacket } from "../../src/contracts/task-packet"

function validPacket() {
  return {
    version: 1,
    runId: "run-1",
    taskId: "T04",
    generation: 1,
    objective: "Fix cafe",
    deliverable: "A contained contract",
    allowedPaths: ["src/contracts/task-packet.ts", "src/contracts/critic-receipt.ts"],
    referenceIds: ["ref-b", "ref-a"],
    dependencyIds: ["T01", "T03"],
    criteria: [
      {
        id: "hashes",
        scenario: "valid packet",
        observable: "hash is stable",
        expected: "sha256",
        evidenceLogicalId: "T04.packet",
      },
    ],
    boundaryTags: ["none"],
    publicBehavior: false,
    tier: "FAST",
    budgets: { maxCalls: 3, maxPacketBytes: 4096, maxRetrievalCalls: 4, maxRetrievalBytes: 16384 },
    evidenceRequirements: [{ logicalId: "T04.packet", kind: "test", required: true }],
  }
}

describe("task packet contract", () => {
  test("Given semantically equivalent set-like arrays When compiled Then bytes are canonical and the hash is stable", () => {
    // Given
    const first = validPacket()
    const second = {
      ...validPacket(),
      allowedPaths: [...first.allowedPaths].reverse(),
      referenceIds: [...first.referenceIds].reverse(),
    }

    // When
    const left = compileTaskPacket(first)
    const right = compileTaskPacket(second)

    // Then
    expect(left).toMatchObject({ ok: true })
    expect(right).toMatchObject({ ok: true })
    if (!left.ok || !right.ok) return
    expect(left.canonicalJson).toBe(right.canonicalJson)
    expect(left.packetHash).toBe(right.packetHash)
    expect(left.packet.referenceIds).toEqual(["ref-a", "ref-b"])
  })

  test("Given a changed semantic field When compiled Then the packet hash changes", () => {
    // Given
    const original = compileTaskPacket(validPacket())
    const changed = compileTaskPacket({
      ...validPacket(),
      publicBehavior: true,
      tier: "STANDARD",
      budgets: {
        maxCalls: 11,
        maxPacketBytes: 8192,
        maxRetrievalCalls: 10,
        maxRetrievalBytes: 65536,
      },
    })

    // When
    const hashes = [original, changed]

    // Then
    expect(hashes.every((result) => result.ok)).toBe(true)
    if (!original.ok || !changed.ok) return
    expect(original.packetHash).not.toBe(changed.packetHash)
  })

  test("Given an oversized FAST packet When compiled Then its budget rejection is stable", () => {
    // Given
    const oversized = { ...validPacket(), objective: "x".repeat(5000) }

    // When
    const result = compileTaskPacket(oversized)

    // Then
    expect(result).toEqual({ ok: false, code: "packet_budget_exceeded" })
  })

  test("Given an escaping path or unknown field When compiled Then strict containment rejects it", () => {
    // Given
    const escaping = { ...validPacket(), allowedPaths: ["../outside.ts"] }
    const forged = { ...validPacket(), forged: true }

    // When
    const escapingResult = compileTaskPacket(escaping)
    const forgedResult = compileTaskPacket(forged)

    // Then
    expect(escapingResult).toEqual({ ok: false, code: "malformed_packet" })
    expect(forgedResult).toEqual({ ok: false, code: "malformed_packet" })
  })
})
