import { describe, expect, test } from "bun:test"
import { COMMAND_REGISTRATIONS } from "../../src/commands/command-definitions"
import {
  evaluateContribution,
  evaluateDoctor,
  LCX_WORKFLOW_CONTRACTS,
  prepareBugReport,
} from "../../src/workflows/lcx-contract"

const cleanDoctorInput = {
  checks: [
    { id: "omp-version", verdict: "pass", evidence: "omp/17.0.5" },
    { id: "package-manifest", verdict: "pass", evidence: "omp-lazy@0.1.0" },
  ],
  deep: false,
} as const

const completeContribution = {
  bugReference: "issue-42",
  cleanup: {
    completed: true,
    foreignStateAfter: "profile-sha256",
    foreignStateBefore: "profile-sha256",
  },
  dryRun: true,
  evidence: [
    { exitCode: 1, stage: "red", surface: "bun-test" },
    { exitCode: 0, stage: "green", surface: "bun-test" },
    { exitCode: 0, stage: "real_surface", surface: "omp-17.0.5" },
  ],
  ownership: "omp-lazy",
  target: "omp-lazy",
} as const

describe("lcx compatibility workflow inventory", () => {
  test("binds each canonical command and exact alias to one shared workflow id", () => {
    // Given: the Todo16-owned compatibility contract and Todo7 catalog.
    expect(LCX_WORKFLOW_CONTRACTS).toEqual([
      {
        alias: "/lcx-doctor",
        canonical: "/omp-lazy-doctor",
        skill: "lcx-doctor",
        workflowId: "doctor",
      },
      {
        alias: "/lcx-report-bug",
        canonical: "/omp-lazy-report-bug",
        skill: "lcx-report-bug",
        workflowId: "report_bug",
      },
      {
        alias: "/lcx-contribute-bug-fix",
        canonical: "/omp-lazy-contribute-bug-fix",
        skill: "lcx-contribute-bug-fix",
        workflowId: "contribute_bug_fix",
      },
    ])

    // When: canonical and alias registrations are resolved.
    for (const contract of LCX_WORKFLOW_CONTRACTS) {
      const canonical = COMMAND_REGISTRATIONS.find(
        (registration) => registration.command === contract.canonical,
      )
      const alias = COMMAND_REGISTRATIONS.find(
        (registration) => registration.command === contract.alias,
      )

      // Then: Todo17 can compose either spelling without creating a second workflow.
      expect(canonical?.workflow).toBe(contract.workflowId)
      expect(alias?.workflow).toBe(contract.workflowId)
    }
  })
})

describe("doctor contract", () => {
  test("returns an evidence-bound read-only diagnosis", () => {
    // Given: captured offline observations.
    // When: the doctor evaluates them.
    const result = evaluateDoctor(cleanDoctorInput)

    // Then: the report is diagnostic-only and performs no external write.
    expect(result).toEqual({
      checks: cleanDoctorInput.checks,
      kind: "report",
      overall: "pass",
      policy: "read_only",
      externalWrite: "not_run",
    })
  })

  test("uses the worst captured verdict without inventing evidence", () => {
    // Given: one warning and one failing observation.
    const checks = [
      { id: "payload", verdict: "warn", evidence: "optional asset missing" },
      { id: "loader", verdict: "fail", evidence: "loader exit 1" },
    ] as const

    // When: the observations are evaluated.
    const result = evaluateDoctor({ checks, deep: true })

    // Then: failure is retained with the original evidence.
    expect(result.overall).toBe("fail")
    expect(result.checks).toEqual(checks)
  })

  test("does not pass a check whose evidence is blank", () => {
    // Given: a nominally passing observation without captured evidence.
    const checks = [{ id: "loader", verdict: "pass", evidence: "   " }] as const

    // When: the doctor evaluates the unbound observation.
    const result = evaluateDoctor({ checks, deep: false })

    // Then: missing evidence prevents an overall PASS.
    expect(result.overall).toBe("warn")
  })
})

describe("bug report contract", () => {
  test("routes an omp-lazy-only reproduction to a local draft", () => {
    // Given: a reproduced integration defect with no duplicate.
    const request = {
      authority: null,
      delivery: "draft",
      duplicates: [],
      reproduction: "omp_lazy_only",
      requestedTarget: "auto",
      summary: "worker receipts are not displayed",
    } as const

    // When: the report contract routes it.
    const result = prepareBugReport(request)

    // Then: ownership is explicit and no network artifact is created.
    expect(result.kind).toBe("draft")
    expect(result).toMatchObject({ owner: "omp-lazy", externalWrite: "not_run" })
  })

  test("routes a clean OMP reproduction upstream and detects duplicates", () => {
    // Given: the same symptom in clean OMP and a supplied offline issue index.
    const duplicate = {
      id: "omp-77",
      summary: "loader loses command aliases",
      target: "omp",
    } as const

    // When: report preparation searches the supplied records.
    const result = prepareBugReport({
      authority: null,
      delivery: "draft",
      duplicates: [duplicate],
      reproduction: "clean_omp",
      requestedTarget: "auto",
      summary: "Loader loses command aliases",
    })

    // Then: it routes to the existing owner without drafting a duplicate.
    expect(result).toEqual({
      duplicate,
      externalWrite: "not_run",
      kind: "duplicate",
      owner: "omp",
    })
  })

  test("hard-stops external delivery without separate authority", () => {
    // Given: an attempt to turn the local workflow into an external write.
    // When: no separately scoped authority is present.
    const result = prepareBugReport({
      authority: null,
      delivery: "external",
      duplicates: [],
      reproduction: "omp_lazy_only",
      requestedTarget: "auto",
      summary: "cannot archive team",
    })

    // Then: the stop is explicit and no external write is attempted.
    expect(result).toEqual({
      code: "external_authority_required",
      externalWrite: "not_run",
      kind: "blocked",
    })
  })

  test("rejects a requested target that conflicts with reproduced ownership", () => {
    // Given: an omp-lazy-only failure forced toward OMP.
    // When: ownership is evaluated.
    const result = prepareBugReport({
      authority: null,
      delivery: "draft",
      duplicates: [],
      reproduction: "omp_lazy_only",
      requestedTarget: "omp",
      summary: "adapter mismatch",
    })

    // Then: the target mismatch fails closed.
    expect(result).toMatchObject({ kind: "blocked", code: "target_mismatch" })
  })
})

describe("contribution dry-run contract", () => {
  test("requires ordered RED, GREEN, and OMP real-surface evidence", () => {
    // Given: a complete v1 dry-run evidence chain.
    // When: the contribution is evaluated.
    const result = evaluateContribution(completeContribution)

    // Then: it is ready only as an offline delivery draft.
    expect(result).toEqual({
      bugReference: "issue-42",
      externalWrite: "not_run",
      kind: "ready",
      target: "omp-lazy",
    })
  })

  test("blocks when RED evidence is absent", () => {
    // Given: GREEN and surface proof without a failing-before observation.
    const evidence = completeContribution.evidence.slice(1)

    // When: the contribution is evaluated.
    const result = evaluateContribution({ ...completeContribution, evidence })

    // Then: missing RED cannot be waived.
    expect(result).toMatchObject({ kind: "blocked", code: "red_required" })
  })

  test("rejects a fabricated OMP surface prefix", () => {
    // Given: otherwise-complete evidence whose surface is only a forged prefix.
    const evidence = completeContribution.evidence.map((entry) =>
      entry.stage === "real_surface" ? { ...entry, surface: "omp-17.0.5-fabricated" } : entry,
    )

    // When: the contribution is evaluated.
    const result = evaluateContribution({ ...completeContribution, evidence })

    // Then: only the exact real OMP surface token is accepted.
    expect(result).toMatchObject({ kind: "blocked", code: "real_surface_required" })
  })

  test("blocks target mismatch, cleanup failure, and foreign state mutation", () => {
    // Given/When/Then: each safety boundary fails independently.
    expect(evaluateContribution({ ...completeContribution, target: "omp" })).toMatchObject({
      kind: "blocked",
      code: "target_mismatch",
    })
    expect(
      evaluateContribution({
        ...completeContribution,
        cleanup: { ...completeContribution.cleanup, completed: false },
      }),
    ).toMatchObject({ kind: "blocked", code: "cleanup_incomplete" })
    expect(
      evaluateContribution({
        ...completeContribution,
        cleanup: { ...completeContribution.cleanup, foreignStateAfter: "changed" },
      }),
    ).toMatchObject({ kind: "blocked", code: "foreign_state_changed" })
  })
})
