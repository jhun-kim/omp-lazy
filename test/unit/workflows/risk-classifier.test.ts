import { describe, expect, test } from "bun:test"
import { classifyWorkflowRisk, RiskTierCeilings } from "../../../src/workflows/risk-classifier"

const baseInput = {
  allowedPaths: ["src/runtime.ts"],
  moduleRoots: ["."],
  boundaryTags: ["none"],
  explicitReview: false,
  mutating: true,
  publicBehavior: false,
} as const

describe("deterministic workflow risk classification", () => {
  test.each([
    ["a concrete boundary", { boundaryTags: ["unknown", "security"] }, "concrete_boundary"],
    ["explicit review", { explicitReview: true }, "explicit_review"],
    [
      "more than eight files",
      { allowedPaths: Array.from({ length: 9 }, (_, index) => `src/file-${index}.ts`) },
      "file_count",
    ],
  ] as const)("Given %s When classified Then DEEP wins by closed precedence", (_label, change, reason) => {
    // Given
    const input = { ...baseInput, ...change }

    // When
    const receipt = classifyWorkflowRisk(input)

    // Then
    expect(receipt).toMatchObject({ status: "PASS", tier: "DEEP", reason })
    if (receipt.status === "PASS" && reason === "concrete_boundary") {
      expect(receipt.features.boundaryTags).toEqual(["security"])
    }
  })

  test.each([
    ["unknown-only boundary", { boundaryTags: ["unknown"] }, "unknown_boundary"],
    ["three files", { allowedPaths: ["src/a.ts", "src/b.ts", "src/c.ts"] }, "file_count"],
    ["multiple modules", { moduleRoots: ["packages/a", "packages/b"] }, "module_count"],
    ["public behavior", { publicBehavior: true }, "public_behavior"],
    [
      "mutating work with no proposed path",
      { allowedPaths: [], moduleRoots: [] },
      "unknown_mutation_path",
    ],
  ] as const)("Given %s When classified Then it routes STANDARD", (_label, change, reason) => {
    // Given
    const input = { ...baseInput, ...change }

    // When
    const receipt = classifyWorkflowRisk(input)

    // Then
    expect(receipt).toMatchObject({ status: "PASS", tier: "STANDARD", reason })
  })

  test.each([
    ["read-only zero-file work", { allowedPaths: [], moduleRoots: [], mutating: false }],
    ["one-file work", {}],
    ["two-file one-module work", { allowedPaths: ["src/a.ts", "src/b.ts"] }],
  ] as const)("Given %s When classified Then it routes FAST", (_label, change) => {
    // Given
    const input = { ...baseInput, ...change }

    // When
    const receipt = classifyWorkflowRisk(input)

    // Then
    expect(receipt).toMatchObject({ status: "PASS", tier: "FAST", reason: "bounded_local" })
  })

  test("Given malformed or open classifier input When parsed Then it blocks deterministically", () => {
    // Given
    const input = { ...baseInput, allowedPaths: ["../escape.ts"], undeclared: true }

    // When
    const receipt = classifyWorkflowRisk(input)

    // Then
    expect(receipt).toEqual({
      schemaVersion: 1,
      status: "BLOCKED",
      code: "invalid_classifier_input",
    })
  })

  test("Given every tier When ceilings are inspected Then packet, retrieval, call, and role bounds are exact", () => {
    // Given / When / Then
    expect(RiskTierCeilings).toEqual({
      FAST: {
        maxCalls: 3,
        maxPacketBytes: 4_096,
        maxRetrievalCalls: 4,
        maxRetrievalBytes: 16_384,
        maxActivePackets: 1,
        maxSemanticRolesPerPacket: 1,
        criticPolicy: "none",
      },
      STANDARD: {
        maxCalls: 11,
        maxPacketBytes: 8_192,
        maxRetrievalCalls: 10,
        maxRetrievalBytes: 65_536,
        maxActivePackets: 2,
        maxSemanticRolesPerPacket: 2,
        criticPolicy: "after_deterministic_failure",
      },
      DEEP: {
        maxCalls: 28,
        maxPacketBytes: 12_288,
        maxRetrievalCalls: 20,
        maxRetrievalBytes: 163_840,
        maxActivePackets: 4,
        maxSemanticRolesPerPacket: 3,
        criticPolicy: "required",
      },
    })
  })
})
