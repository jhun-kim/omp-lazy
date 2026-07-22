import { describe, expect, test } from "bun:test"
import { TierBudgets } from "../../../src/contracts/task-packet"
import type { AnyRun } from "../../../src/state/domain"
import { UuidSchema } from "../../../src/state/domain"
import {
  compilePromptStepContext,
  compileRunStepContext,
  compileStepContext,
  TASK_PACKET_CUSTOM_TYPE,
} from "../../../src/workflows/task-packet-compiler"

function packet(objective = "Implement the compact runtime packet") {
  return {
    version: 1,
    runId: "run-t07",
    taskId: "T07",
    generation: 1,
    objective,
    deliverable: "A measured compact context",
    allowedPaths: ["src/observers/product-runtime-observer.ts"],
    referenceIds: ["T04"],
    dependencyIds: ["T06"],
    criteria: [
      {
        id: "context",
        scenario: "runtime packet",
        observable: "one current packet reaches the model",
        expected: "stale packets are absent",
        evidenceLogicalId: "T07.context",
      },
    ],
    boundaryTags: ["none"],
    publicBehavior: false,
    tier: "FAST",
    budgets: TierBudgets.FAST,
    evidenceRequirements: [{ logicalId: "T07.context", kind: "test", required: true }],
  }
}

describe("compact task packet compiler", () => {
  test("Given a canonical step When compiled Then one hidden hash-bound custom message is produced", () => {
    // Given
    const input = packet()

    // When
    const result = compileStepContext(input)

    // Then
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.message).toEqual({
      customType: TASK_PACKET_CUSTOM_TYPE,
      content: result.compiled.canonicalJson,
      display: false,
      details: {
        version: 1,
        packetHash: result.compiled.packetHash,
        packetBytes: result.compiled.packetBytes,
        runId: "run-t07",
        taskId: "T07",
        generation: 1,
        tier: "FAST",
      },
    })
  })

  test("Given a UTF-8 FAST packet over four KiB When compiled Then the byte refusal is stable", () => {
    // Given
    const input = packet("계".repeat(2_100))

    // When
    const result = compileStepContext(input)

    // Then
    expect(result).toEqual({ ok: false, code: "packet_budget_exceeded" })
  })

  test("Given a canonical worker prompt When parsed Then the same packet hash activates", () => {
    // Given
    const parent = compileStepContext(packet())
    if (!parent.ok) throw new Error(parent.code)

    // When
    const worker = compilePromptStepContext(parent.compiled.canonicalJson)

    // Then
    expect(worker).toMatchObject({
      ok: true,
      compiled: { packetHash: parent.compiled.packetHash },
    })
  })

  test("Given an approved plan with suffixed final-wave rows When compiled Then the declared current step remains usable", () => {
    // Given
    const markdown = [
      "<!-- omp-lazy-ulw-plan:plan:v2 -->",
      "## TL;DR (For humans)",
      "summary",
      "## Scope",
      "scope",
      "## Verification strategy",
      "verify",
      "## Execution strategy",
      "execute",
      "## Todos",
      "- [ ] **T07. Compile compact context**",
      "  - **Implementation:** Meter every result.",
      "  - **References:** `src/extension/register-extension.ts`.",
      "  - **Acceptance:** Stale packets are absent.",
      "## Final verification wave",
      "- [ ] **F1. Audit** — require approval.",
      "## Commit strategy",
      "commit",
      "## Success criteria",
      "done",
    ].join("\n")
    const run: AnyRun = {
      schemaVersion: 2,
      packetHash: null,
      expectedHead: null,
      runId: UuidSchema.parse("11111111-1111-4111-8111-111111111111"),
      workflow: "start_work",
      revision: 2,
      transactionRevision: 2,
      owner: { sessionId: "session-a", epoch: 1 },
      progressRevision: 1,
      continuation: {
        lastProcessedLeafId: null,
        progressRevisionSeen: 0,
        noProgressAttempts: 0,
        stuck: false,
      },
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
      payload: {
        kind: "start_work",
        status: "active",
        plan: {
          planId: UuidSchema.parse("22222222-2222-4222-8222-222222222222"),
          canonicalPath: ".omo/plans/work.md",
          displayPath: "C:/repo/.omo/plans/work.md",
          allowedRoot: "C:/repo",
          allowedRootDisplay: "C:/repo",
          taskFingerprint: "fixture",
          taskIds: ["T07"],
        },
      },
    }

    // When
    const result = compileRunStepContext({ run, repositoryRoot: "C:/repo", planMarkdown: markdown })

    // Then
    expect(result).toMatchObject({
      ok: true,
      compiled: { packet: { taskId: "T07", generation: 2 } },
    })
  })
})
