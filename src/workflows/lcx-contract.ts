import { win32 } from "node:path"
import type { WorkflowActivationId } from "../activation/types"

export const LCX_WORKFLOW_CONTRACTS = [
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
] as const satisfies readonly {
  readonly alias: `/${string}`
  readonly canonical: `/${string}`
  readonly skill: string
  readonly workflowId: WorkflowActivationId
}[]

type ExternalWriteReceipt = { readonly externalWrite: "not_run" }
type Target = "omp-lazy" | "omp"
type Verdict = "pass" | "warn" | "fail"

export type DoctorCheck = {
  readonly id: string
  readonly verdict: Verdict
  readonly evidence: string
}

export function evaluateDoctor(input: {
  readonly checks: readonly DoctorCheck[]
  readonly deep: boolean
}): {
  readonly checks: readonly DoctorCheck[]
  readonly kind: "report"
  readonly overall: Verdict
  readonly policy: "read_only"
  readonly externalWrite: "not_run"
} {
  const overall = input.checks.some((check) => check.verdict === "fail")
    ? "fail"
    : input.checks.length === 0 ||
        input.checks.some((check) => check.verdict === "warn" || check.evidence.trim().length === 0)
      ? "warn"
      : "pass"
  return {
    checks: input.checks,
    externalWrite: "not_run",
    kind: "report",
    overall,
    policy: "read_only",
  }
}

export type DuplicateReport = {
  readonly id: string
  readonly summary: string
  readonly target: Target
}

type ReportRequest = {
  readonly authority: null | {
    readonly planId: string
    readonly scope: "external_issue_or_pr"
  }
  readonly delivery: "draft" | "external"
  readonly duplicates: readonly DuplicateReport[]
  readonly reproduction: "omp_lazy_only" | "clean_omp" | "ambiguous"
  readonly requestedTarget: "auto" | Target
  readonly summary: string
}

type ReportResult =
  | ({
      readonly kind: "draft"
      readonly owner: Target
      readonly body: string
    } & ExternalWriteReceipt)
  | ({
      readonly kind: "duplicate"
      readonly owner: Target
      readonly duplicate: DuplicateReport
    } & ExternalWriteReceipt)
  | ({
      readonly kind: "blocked"
      readonly code:
        | "external_authority_required"
        | "external_delivery_not_supported_v1"
        | "ownership_ambiguous"
        | "summary_required"
        | "target_mismatch"
    } & ExternalWriteReceipt)

export function prepareBugReport(request: ReportRequest): ReportResult {
  if (request.summary.trim().length === 0) {
    return { code: "summary_required", externalWrite: "not_run", kind: "blocked" }
  }
  if (request.delivery === "external") {
    return request.authority === null
      ? { code: "external_authority_required", externalWrite: "not_run", kind: "blocked" }
      : {
          code: "external_delivery_not_supported_v1",
          externalWrite: "not_run",
          kind: "blocked",
        }
  }
  const owner =
    request.reproduction === "omp_lazy_only"
      ? "omp-lazy"
      : request.reproduction === "clean_omp"
        ? "omp"
        : null
  if (owner === null) {
    return { code: "ownership_ambiguous", externalWrite: "not_run", kind: "blocked" }
  }
  if (request.requestedTarget !== "auto" && request.requestedTarget !== owner) {
    return { code: "target_mismatch", externalWrite: "not_run", kind: "blocked" }
  }
  const normalizedSummary = request.summary.trim().toLocaleLowerCase("en-US")
  const duplicate = request.duplicates.find(
    (candidate) =>
      candidate.target === owner &&
      candidate.summary.trim().toLocaleLowerCase("en-US") === normalizedSummary,
  )
  if (duplicate !== undefined) {
    return { duplicate, externalWrite: "not_run", kind: "duplicate", owner }
  }
  return {
    body: `## Summary\n${request.summary.trim()}\n\n## Ownership\nTarget: ${owner}\n`,
    externalWrite: "not_run",
    kind: "draft",
    owner,
  }
}

type ContributionStage = {
  readonly exitCode: number
  readonly stage: "red" | "green" | "real_surface"
  readonly surface: string
}

type ContributionRequest = {
  readonly bugReference: string
  readonly cleanup: {
    readonly completed: boolean
    readonly foreignStateAfter: string
    readonly foreignStateBefore: string
  }
  readonly dryRun: boolean
  readonly evidence: readonly ContributionStage[]
  readonly ownership: Target
  readonly target: Target
}

type ContributionResult =
  | ({
      readonly bugReference: string
      readonly kind: "ready"
      readonly target: Target
    } & ExternalWriteReceipt)
  | ({
      readonly kind: "blocked"
      readonly code:
        | "bug_reference_required"
        | "cleanup_incomplete"
        | "dry_run_required"
        | "evidence_sequence_invalid"
        | "foreign_state_changed"
        | "green_required"
        | "real_surface_required"
        | "red_required"
        | "target_mismatch"
    } & ExternalWriteReceipt)

const blockedContribution = (
  code: Extract<ContributionResult, { kind: "blocked" }>["code"],
): ContributionResult => ({
  code,
  externalWrite: "not_run",
  kind: "blocked",
})

export function evaluateContribution(request: ContributionRequest): ContributionResult {
  if (!request.dryRun) return blockedContribution("dry_run_required")
  if (request.bugReference.trim().length === 0) return blockedContribution("bug_reference_required")
  if (request.target !== request.ownership) return blockedContribution("target_mismatch")
  const red = request.evidence.find((entry) => entry.stage === "red")
  if (red === undefined || red.exitCode === 0) return blockedContribution("red_required")
  const green = request.evidence.find((entry) => entry.stage === "green")
  if (green === undefined || green.exitCode !== 0) return blockedContribution("green_required")
  const surface = request.evidence.find((entry) => entry.stage === "real_surface")
  if (surface === undefined || surface.exitCode !== 0 || surface.surface !== "omp-17.0.5") {
    return blockedContribution("real_surface_required")
  }
  if (
    request.evidence.length !== 3 ||
    request.evidence[0]?.stage !== "red" ||
    request.evidence[1]?.stage !== "green" ||
    request.evidence[2]?.stage !== "real_surface"
  ) {
    return blockedContribution("evidence_sequence_invalid")
  }
  if (!request.cleanup.completed) return blockedContribution("cleanup_incomplete")
  if (request.cleanup.foreignStateBefore !== request.cleanup.foreignStateAfter) {
    return blockedContribution("foreign_state_changed")
  }
  return {
    bugReference: request.bugReference.trim(),
    externalWrite: "not_run",
    kind: "ready",
    target: request.target,
  }
}

type WindowsAdapterArguments = {
  readonly evidenceRoot: string
  readonly mode: "offline"
  readonly ompExecutable: string
  readonly projectRoot: string
}

export function parseLcxWindowsAdapterArguments(
  argv: readonly string[],
):
  | { readonly ok: true; readonly value: WindowsAdapterArguments }
  | { readonly ok: false; readonly code: "absolute_windows_path_required" | "invalid_arguments" } {
  if (
    argv.length !== 6 ||
    argv[0] !== "--project-root" ||
    argv[2] !== "--omp-exe" ||
    argv[4] !== "--evidence-root"
  ) {
    return { code: "invalid_arguments", ok: false }
  }
  const projectRoot = argv[1] ?? ""
  const ompExecutable = argv[3] ?? ""
  const evidenceRoot = argv[5] ?? ""
  if (
    [projectRoot, ompExecutable, evidenceRoot].some(
      (path) =>
        path.includes("\0") || !win32.isAbsolute(path) || win32.parse(path).root === win32.sep,
    )
  ) {
    return { code: "absolute_windows_path_required", ok: false }
  }
  return {
    ok: true,
    value: { evidenceRoot, mode: "offline", ompExecutable, projectRoot },
  }
}
