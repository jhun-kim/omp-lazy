import { describe, expect, test } from "bun:test"
import { initialWorkerRoute, reduceWorkerFailure } from "../../../src/workflows/escalation-policy"

describe("low-first bounded escalation", () => {
  test.each([
    ["FAST", ["@smol"]],
    ["STANDARD", ["@smol", "@task"]],
    ["DEEP", ["@smol", "@task", "@slow"]],
  ] as const)("Given %s work When routing starts Then it begins at low with an exact role ceiling", (tier, roles) => {
    // Given / When
    const receipt = initialWorkerRoute(tier)

    // Then
    expect(receipt).toEqual({
      schemaVersion: 1,
      status: "PASS",
      action: "DISPATCH",
      tier,
      role: "@smol",
      semanticAttempt: 1,
      transportRequest: 1,
      allowedRoles: roles,
    })
  })

  test("Given semantic failures When reduced Then STANDARD escalates once and DEEP twice without repeating a role", () => {
    // Given
    const standard = initialWorkerRoute("STANDARD")
    const deep = initialWorkerRoute("DEEP")

    // When
    const standardTask = reduceWorkerFailure(standard, "semantic_mismatch")
    const standardExhausted = reduceWorkerFailure(standardTask, "test_failure")
    const deepTask = reduceWorkerFailure(deep, "test_failure")
    const deepSlow = reduceWorkerFailure(deepTask, "semantic_mismatch")
    const deepExhausted = reduceWorkerFailure(deepSlow, "test_failure")

    // Then
    expect(standardTask).toMatchObject({ action: "ESCALATE", role: "@task", semanticAttempt: 2 })
    expect(standardExhausted).toMatchObject({
      status: "BLOCKED",
      action: "FAIL",
      code: "budget_exhausted",
    })
    expect([deepTask.role, deepSlow.role]).toEqual(["@task", "@slow"])
    expect(deepExhausted).toMatchObject({
      status: "BLOCKED",
      action: "FAIL",
      code: "budget_exhausted",
    })
  })

  test("Given FAST new-boundary evidence When reduced Then it persists only FAST-to-STANDARD task escalation", () => {
    // Given
    const route = initialWorkerRoute("FAST")

    // When
    const receipt = reduceWorkerFailure(route, "new_boundary")

    // Then
    expect(receipt).toMatchObject({
      status: "PASS",
      action: "ESCALATE",
      tier: "STANDARD",
      previousTier: "FAST",
      role: "@task",
      semanticAttempt: 2,
      code: "new_boundary",
    })
  })

  test("Given a transient transport failure When reduced twice Then one resend stays in-attempt before role escalation", () => {
    // Given
    const route = initialWorkerRoute("STANDARD")

    // When
    const resend = reduceWorkerFailure(route, "transport_transient")
    const escalated = reduceWorkerFailure(resend, "transport_transient")

    // Then
    expect(resend).toMatchObject({
      action: "RESEND",
      role: "@smol",
      semanticAttempt: 1,
      transportRequest: 2,
    })
    expect(escalated).toMatchObject({
      action: "ESCALATE",
      role: "@task",
      semanticAttempt: 2,
      transportRequest: 1,
    })
  })

  test("Given provider unavailability When its one resend also fails Then it blocks without changing roles", () => {
    // Given
    const route = initialWorkerRoute("DEEP")

    // When
    const resend = reduceWorkerFailure(route, "provider_unavailable")
    const blocked = reduceWorkerFailure(resend, "provider_unavailable")

    // Then
    expect(resend).toMatchObject({ action: "RESEND", role: "@smol", transportRequest: 2 })
    expect(blocked).toMatchObject({
      status: "BLOCKED",
      action: "BLOCK",
      role: "@smol",
      code: "provider_unavailable",
    })
  })

  test.each([
    "authorization",
    "containment",
    "stale_state",
    "cleanup_failure",
    "unknown",
  ] as const)("Given hard failure %s When reduced Then it never resends or escalates", (failure) => {
    // Given
    const route = initialWorkerRoute("DEEP")

    // When
    const receipt = reduceWorkerFailure(route, failure)

    // Then
    expect(receipt).toMatchObject({
      status: "BLOCKED",
      action: "BLOCK",
      role: "@smol",
      code: failure,
      semanticAttempt: 1,
      transportRequest: 1,
    })
  })
})
