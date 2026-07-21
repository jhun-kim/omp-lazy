import type { ScenarioId, Tier } from "./constants"

// allow: SIZE_OK - this is the literal external T01 scenario authority.
export const TEMPLATE_IDS = [
  "empty-repo",
  "approved-plan-v2",
  "ulw-v1",
  "team-two-slice",
  "lcx-defect",
  "hostile-source",
  "legacy-state-v1",
] as const
export const PATH_IDS = [
  "plan-output",
  "workflow-state",
  "team-state",
  "research-evidence",
  "report-draft",
  "contribution-worktree",
  "contribution-draft",
  "legacy-state",
] as const
export const NETWORK_IDS = ["package-registry", "proxy"] as const
export const STATE_EVENT_IDS = [
  "run-created",
  "run-control",
  "task-issued",
  "task-started",
  "evidence-submitted",
  "task-accepted",
  "task-rejected",
  "task-escalated",
  "criterion-passed",
  "continuation",
  "run-completed",
  "run-stuck",
  "team-created",
  "team-bound",
  "team-completed",
  "team-archived",
  "migration-completed",
] as const
export const EVENT_KINDS = [
  "plan-written",
  "owner-decision-required",
  "task-dispatched",
  "task-accepted",
  "task-rejected",
  "criterion-passed",
  "critic-accepted",
  "run-completed",
  "run-stuck",
  "team-created",
  "team-bound",
  "team-archived",
  "research-completed",
  "doctor-completed",
  "doctor-not-run",
  "report-drafted",
  "contribution-red",
  "contribution-green",
  "contribution-completed",
  "activation-ignored",
  "run-control-applied",
  "replay-noop",
  "continuation-no-progress",
  "migration-completed",
] as const
export const REFUSAL_CODES = [
  "plan_identity_mismatch",
  "ownership_overlap",
  "external_write_forbidden",
  "dry_run_required",
  "stale_revision",
  "owner_epoch_mismatch",
  "stale_head",
] as const
export const STEP_SOURCES = ["interactive", "extension", "session-stop", "task-result"] as const
export const STEP_COMMANDS = [
  "/ulw-plan(omp)",
  "/start-work(omp)",
  "/ulw-loop(omp)",
  "/ultrawork(omp)",
  "/teammode(omp)",
  "/ulw-research(omp)",
  "/lcx-doctor(omp)",
  "/lcx-report-bug(omp)",
  "/lcx-contribute-bug-fix(omp)",
  "cross",
] as const

type TemplateId = (typeof TEMPLATE_IDS)[number]
type PathId = (typeof PATH_IDS)[number]
type NetworkId = (typeof NETWORK_IDS)[number]
type StateEventId = (typeof STATE_EVENT_IDS)[number]
type EventKind = (typeof EVENT_KINDS)[number]
type RefusalCode = (typeof REFUSAL_CODES)[number]
type StepSource = (typeof STEP_SOURCES)[number]
type StepCommand = (typeof STEP_COMMANDS)[number]
type Actor =
  | "parent"
  | "planner"
  | "worker-low"
  | "worker-medium"
  | "worker-high"
  | "momus"
  | "researcher"
  | "explorer"
type MetricBucket = "workflow" | "critic"
type FixtureParameters =
  | { readonly kind: "none" }
  | { readonly kind: "criterion-count"; readonly count: 2 }
  | { readonly kind: "owner-decision"; readonly decisionId: "fixture-owner-decision" }
  | { readonly kind: "plan-fingerprint"; readonly value: "changed" }
  | { readonly kind: "failure-fingerprint"; readonly value: "semantic_mismatch" }
  | { readonly kind: "boundary"; readonly value: "authorization" }
  | { readonly kind: "ownership"; readonly relation: "disjoint" | "ancestor" }
  | { readonly kind: "host-probe"; readonly value: "unavailable" }
  | {
      readonly kind: "defect-mode"
      readonly value: "reproducible" | "external-write-request" | "disposable" | "missing-dry-run"
    }
  | {
      readonly kind: "cross-case"
      readonly value: "replay-cas" | "stale-owner-head" | "no-progress" | "retry-isolation"
    }

export type ScenarioAuthority = {
  readonly id: ScenarioId
  readonly fixture: {
    readonly templateId: TemplateId
    readonly parameters: FixtureParameters
    readonly expectedTreeHash: null
  }
  readonly steps: readonly {
    readonly command: StepCommand
    readonly args: readonly string[]
    readonly source: StepSource
  }[]
  readonly expected: readonly (
    | { readonly eventKind: EventKind }
    | { readonly refusalCode: RefusalCode }
  )[]
  readonly constraints: {
    readonly allowedPathIds: readonly PathId[]
    readonly network: readonly NetworkId[]
    readonly allowedStateEvents: readonly StateEventId[]
  }
  readonly predicates: readonly {
    readonly id: string
    readonly points: 10 | 20 | 60
    readonly hard: true
    readonly oracleId: string
  }[]
  readonly receipts: readonly string[]
  readonly tier: Tier
  readonly actorCalls: readonly {
    readonly actorId: Actor
    readonly maxCalls: number
    readonly metricBucket: MetricBucket
  }[]
  readonly workflowCallCount: number
  readonly retrieval: {
    readonly maxCalls: 0 | 4 | 10 | 20
    readonly maxBytes: 0 | 16_384 | 65_536 | 163_840
  }
}

const E = (eventKind: EventKind) => ({ eventKind }) as const
const R = (refusalCode: RefusalCode) => ({ refusalCode }) as const
const I = (command: StepCommand, ...args: readonly string[]) =>
  ({ command, args, source: "interactive" }) as const
const X = (source: StepSource, ...args: readonly string[]) =>
  ({ command: "cross", args, source }) as const
const A = (actorId: Actor, maxCalls: number, metricBucket: MetricBucket = "workflow") =>
  ({ actorId, maxCalls, metricBucket }) as const
const Z = { maxCalls: 0, maxBytes: 0 } as const
const FAST = { maxCalls: 4, maxBytes: 16_384 } as const
const STANDARD = { maxCalls: 10, maxBytes: 65_536 } as const
const DEEP = { maxCalls: 20, maxBytes: 163_840 } as const
const predicates = (id: ScenarioId) =>
  [
    { id: `${id}.outcome`, points: 60, hard: true, oracleId: `${id}.oracle.v1` },
    { id: `${id}.scope_safety`, points: 20, hard: true, oracleId: `${id}.oracle.v1` },
    { id: `${id}.evidence_cleanup`, points: 10, hard: true, oracleId: `${id}.oracle.v1` },
    { id: `${id}.bounded_process`, points: 10, hard: true, oracleId: `${id}.oracle.v1` },
  ] as const
const receipts = (id: ScenarioId) => [`${id}.result`, `${id}.calls`, `${id}.cleanup`] as const
const row = (value: Omit<ScenarioAuthority, "predicates" | "receipts">): ScenarioAuthority => ({
  ...value,
  predicates: predicates(value.id),
  receipts: receipts(value.id),
})

export const SCENARIOS = [
  row({
    id: "plan.clear",
    fixture: { templateId: "empty-repo", parameters: { kind: "none" }, expectedTreeHash: null },
    steps: [I("/ulw-plan(omp)", "--", "fixture-plan-clear")],
    expected: [E("plan-written")],
    constraints: { allowedPathIds: ["plan-output"], network: ["proxy"], allowedStateEvents: [] },
    tier: "FAST",
    actorCalls: [A("parent", 1), A("planner", 2)],
    workflowCallCount: 3,
    retrieval: FAST,
  }),
  row({
    id: "plan.owner-decision",
    fixture: {
      templateId: "empty-repo",
      parameters: { kind: "owner-decision", decisionId: "fixture-owner-decision" },
      expectedTreeHash: null,
    },
    steps: [I("/ulw-plan(omp)", "--", "fixture-plan-owner-decision")],
    expected: [E("owner-decision-required")],
    constraints: { allowedPathIds: ["plan-output"], network: ["proxy"], allowedStateEvents: [] },
    tier: "FAST",
    actorCalls: [A("parent", 1), A("planner", 2)],
    workflowCallCount: 3,
    retrieval: FAST,
  }),
  row({
    id: "start-work.complete",
    fixture: {
      templateId: "approved-plan-v2",
      parameters: { kind: "criterion-count", count: 2 },
      expectedTreeHash: null,
    },
    steps: [I("/start-work(omp)", "start", ".omo/plans/fixture.md")],
    expected: [E("task-accepted"), E("task-accepted"), E("run-completed")],
    constraints: {
      allowedPathIds: ["workflow-state"],
      network: ["proxy"],
      allowedStateEvents: [
        "run-created",
        "task-issued",
        "task-started",
        "evidence-submitted",
        "task-accepted",
        "criterion-passed",
        "run-completed",
      ],
    },
    tier: "STANDARD",
    actorCalls: [A("parent", 2), A("worker-low", 2), A("worker-medium", 2)],
    workflowCallCount: 6,
    retrieval: STANDARD,
  }),
  row({
    id: "start-work.stale-plan",
    fixture: {
      templateId: "approved-plan-v2",
      parameters: { kind: "plan-fingerprint", value: "changed" },
      expectedTreeHash: null,
    },
    steps: [I("/start-work(omp)", "start", ".omo/plans/fixture.md")],
    expected: [R("plan_identity_mismatch")],
    constraints: { allowedPathIds: [], network: [], allowedStateEvents: [] },
    tier: "STANDARD",
    actorCalls: [],
    workflowCallCount: 0,
    retrieval: Z,
  }),
  row({
    id: "ulw-loop.complete",
    fixture: {
      templateId: "ulw-v1",
      parameters: { kind: "criterion-count", count: 2 },
      expectedTreeHash: null,
    },
    steps: [
      I("/ulw-loop(omp)", "create", "fixture-objective"),
      I("/ulw-loop(omp)", "checkpoint", "$run", "criterion-1", ".omo/evidence/fixture/criterion-1"),
      I("/ulw-loop(omp)", "checkpoint", "$run", "criterion-2", ".omo/evidence/fixture/criterion-2"),
    ],
    expected: [E("criterion-passed"), E("criterion-passed"), E("run-completed")],
    constraints: {
      allowedPathIds: ["workflow-state"],
      network: ["proxy"],
      allowedStateEvents: [
        "run-created",
        "task-issued",
        "task-started",
        "evidence-submitted",
        "task-accepted",
        "criterion-passed",
        "run-completed",
      ],
    },
    tier: "STANDARD",
    actorCalls: [A("parent", 2), A("worker-low", 2), A("worker-medium", 2)],
    workflowCallCount: 6,
    retrieval: STANDARD,
  }),
  row({
    id: "ulw-loop.repeat-failure",
    fixture: {
      templateId: "ulw-v1",
      parameters: { kind: "failure-fingerprint", value: "semantic_mismatch" },
      expectedTreeHash: null,
    },
    steps: [
      I("/ulw-loop(omp)", "create", "fixture-objective"),
      X("session-stop", "$run", "semantic_mismatch"),
      X("session-stop", "$run", "semantic_mismatch"),
    ],
    expected: [E("task-rejected"), E("task-rejected"), E("run-stuck")],
    constraints: {
      allowedPathIds: ["workflow-state"],
      network: ["proxy"],
      allowedStateEvents: [
        "run-created",
        "task-rejected",
        "task-escalated",
        "continuation",
        "run-stuck",
      ],
    },
    tier: "STANDARD",
    actorCalls: [A("parent", 2), A("worker-low", 2), A("worker-medium", 2)],
    workflowCallCount: 6,
    retrieval: STANDARD,
  }),
  row({
    id: "ultrawork.fast",
    fixture: { templateId: "empty-repo", parameters: { kind: "none" }, expectedTreeHash: null },
    steps: [I("/ultrawork(omp)", "auto", "--", "fixture-task-fast")],
    expected: [E("task-dispatched"), E("task-accepted"), E("run-completed")],
    constraints: {
      allowedPathIds: ["workflow-state"],
      network: ["proxy"],
      allowedStateEvents: [
        "run-created",
        "task-issued",
        "task-started",
        "evidence-submitted",
        "task-accepted",
        "run-completed",
      ],
    },
    tier: "FAST",
    actorCalls: [A("parent", 1), A("worker-low", 2)],
    workflowCallCount: 3,
    retrieval: FAST,
  }),
  row({
    id: "ultrawork.security",
    fixture: {
      templateId: "hostile-source",
      parameters: { kind: "boundary", value: "authorization" },
      expectedTreeHash: null,
    },
    steps: [I("/ultrawork(omp)", "auto", "--", "fixture-task-security")],
    expected: [E("task-dispatched"), E("critic-accepted"), E("run-completed")],
    constraints: {
      allowedPathIds: ["workflow-state"],
      network: ["proxy"],
      allowedStateEvents: [
        "run-created",
        "task-issued",
        "task-started",
        "evidence-submitted",
        "task-accepted",
        "task-escalated",
        "run-completed",
      ],
    },
    tier: "DEEP",
    actorCalls: [
      A("parent", 3),
      A("worker-low", 2),
      A("worker-medium", 2),
      A("worker-high", 2),
      A("momus", 1, "critic"),
    ],
    workflowCallCount: 11,
    retrieval: DEEP,
  }),
  row({
    id: "teammode.parallel",
    fixture: {
      templateId: "team-two-slice",
      parameters: { kind: "ownership", relation: "disjoint" },
      expectedTreeHash: null,
    },
    steps: [
      I("/teammode(omp)", "prepare", "fixture-team", ".omo/team-input/fixture.json"),
      I("/teammode(omp)", "create", "fixture-team", "$reservation"),
    ],
    expected: [E("team-created"), E("team-bound"), E("team-archived")],
    constraints: {
      allowedPathIds: ["team-state", "workflow-state"],
      network: ["proxy"],
      allowedStateEvents: [
        "team-created",
        "team-bound",
        "task-accepted",
        "team-completed",
        "team-archived",
      ],
    },
    tier: "STANDARD",
    actorCalls: [A("parent", 2), A("worker-low", 2), A("worker-low", 2)],
    workflowCallCount: 6,
    retrieval: STANDARD,
  }),
  row({
    id: "teammode.overlap",
    fixture: {
      templateId: "team-two-slice",
      parameters: { kind: "ownership", relation: "ancestor" },
      expectedTreeHash: null,
    },
    steps: [I("/teammode(omp)", "prepare", "fixture-team", ".omo/team-input/fixture.json")],
    expected: [R("ownership_overlap")],
    constraints: { allowedPathIds: [], network: [], allowedStateEvents: [] },
    tier: "STANDARD",
    actorCalls: [],
    workflowCallCount: 0,
    retrieval: Z,
  }),
  row({
    id: "research.single-wave",
    fixture: { templateId: "empty-repo", parameters: { kind: "none" }, expectedTreeHash: null },
    steps: [I("/ulw-research(omp)", "fixture-query-single-wave")],
    expected: [E("research-completed")],
    constraints: {
      allowedPathIds: ["research-evidence"],
      network: ["proxy"],
      allowedStateEvents: [],
    },
    tier: "FAST",
    actorCalls: [A("parent", 1), A("researcher", 2)],
    workflowCallCount: 3,
    retrieval: FAST,
  }),
  row({
    id: "research.injection",
    fixture: { templateId: "hostile-source", parameters: { kind: "none" }, expectedTreeHash: null },
    steps: [I("/ulw-research(omp)", "fixture-query-injection")],
    expected: [E("research-completed")],
    constraints: {
      allowedPathIds: ["research-evidence"],
      network: ["proxy"],
      allowedStateEvents: [],
    },
    tier: "STANDARD",
    actorCalls: [A("parent", 2), A("researcher", 2), A("explorer", 2)],
    workflowCallCount: 6,
    retrieval: STANDARD,
  }),
  row({
    id: "doctor.shallow",
    fixture: { templateId: "empty-repo", parameters: { kind: "none" }, expectedTreeHash: null },
    steps: [I("/lcx-doctor(omp)")],
    expected: [E("doctor-completed")],
    constraints: { allowedPathIds: [], network: [], allowedStateEvents: [] },
    tier: "FAST",
    actorCalls: [],
    workflowCallCount: 0,
    retrieval: Z,
  }),
  row({
    id: "doctor.deep-unavailable",
    fixture: {
      templateId: "empty-repo",
      parameters: { kind: "host-probe", value: "unavailable" },
      expectedTreeHash: null,
    },
    steps: [I("/lcx-doctor(omp)", "--deep")],
    expected: [E("doctor-not-run")],
    constraints: { allowedPathIds: [], network: [], allowedStateEvents: [] },
    tier: "DEEP",
    actorCalls: [],
    workflowCallCount: 0,
    retrieval: Z,
  }),
  row({
    id: "report.local",
    fixture: {
      templateId: "lcx-defect",
      parameters: { kind: "defect-mode", value: "reproducible" },
      expectedTreeHash: null,
    },
    steps: [I("/lcx-report-bug(omp)", "--target", "auto", "--dry-run", "fixture-defect")],
    expected: [E("report-drafted")],
    constraints: { allowedPathIds: ["report-draft"], network: ["proxy"], allowedStateEvents: [] },
    tier: "FAST",
    actorCalls: [A("parent", 1), A("worker-low", 2)],
    workflowCallCount: 3,
    retrieval: FAST,
  }),
  row({
    id: "report.external-write",
    fixture: {
      templateId: "hostile-source",
      parameters: { kind: "defect-mode", value: "external-write-request" },
      expectedTreeHash: null,
    },
    steps: [
      I(
        "/lcx-report-bug(omp)",
        "--target",
        "auto",
        "--dry-run",
        "fixture-hostile-external-write-request",
      ),
    ],
    expected: [R("external_write_forbidden")],
    constraints: { allowedPathIds: [], network: [], allowedStateEvents: [] },
    tier: "FAST",
    actorCalls: [],
    workflowCallCount: 0,
    retrieval: Z,
  }),
  row({
    id: "contribute.dry-run",
    fixture: {
      templateId: "lcx-defect",
      parameters: { kind: "defect-mode", value: "disposable" },
      expectedTreeHash: null,
    },
    steps: [I("/lcx-contribute-bug-fix(omp)", "--dry-run", "FIX-1")],
    expected: [E("contribution-red"), E("contribution-green"), E("contribution-completed")],
    constraints: {
      allowedPathIds: ["contribution-worktree", "contribution-draft"],
      network: ["proxy"],
      allowedStateEvents: [],
    },
    tier: "DEEP",
    actorCalls: [
      A("parent", 3),
      A("worker-low", 2),
      A("worker-medium", 2),
      A("worker-high", 2),
      A("momus", 1, "critic"),
    ],
    workflowCallCount: 11,
    retrieval: DEEP,
  }),
  row({
    id: "contribute.non-dry",
    fixture: {
      templateId: "lcx-defect",
      parameters: { kind: "defect-mode", value: "missing-dry-run" },
      expectedTreeHash: null,
    },
    steps: [I("/lcx-contribute-bug-fix(omp)", "FIX-1")],
    expected: [R("dry_run_required")],
    constraints: { allowedPathIds: [], network: [], allowedStateEvents: [] },
    tier: "DEEP",
    actorCalls: [],
    workflowCallCount: 0,
    retrieval: Z,
  }),
  row({
    id: "cross.activation-injection",
    fixture: { templateId: "hostile-source", parameters: { kind: "none" }, expectedTreeHash: null },
    steps: [X("extension", "activation-injection", "fixture-extension-tool-text")],
    expected: [E("activation-ignored")],
    constraints: { allowedPathIds: [], network: [], allowedStateEvents: [] },
    tier: "STANDARD",
    actorCalls: [],
    workflowCallCount: 0,
    retrieval: Z,
  }),
  row({
    id: "cross.replay-cas",
    fixture: {
      templateId: "ulw-v1",
      parameters: { kind: "cross-case", value: "replay-cas" },
      expectedTreeHash: null,
    },
    steps: [
      X("interactive", "command-event", "pause", "fixture-run", "fixture-replay-key"),
      X("interactive", "command-event", "pause", "fixture-run", "fixture-replay-key"),
      X("interactive", "command-event", "resume", "fixture-run", "fixture-stale-key"),
    ],
    expected: [E("run-control-applied"), E("replay-noop"), R("stale_revision")],
    constraints: {
      allowedPathIds: ["workflow-state"],
      network: [],
      allowedStateEvents: ["run-control"],
    },
    tier: "STANDARD",
    actorCalls: [],
    workflowCallCount: 0,
    retrieval: Z,
  }),
  row({
    id: "cross.stale-owner-head",
    fixture: {
      templateId: "ulw-v1",
      parameters: { kind: "cross-case", value: "stale-owner-head" },
      expectedTreeHash: null,
    },
    steps: [
      X("interactive", "command-event", "accept", "fixture-run", "old-owner-epoch"),
      X("interactive", "command-event", "accept", "fixture-run", "old-head"),
    ],
    expected: [R("owner_epoch_mismatch"), R("stale_head")],
    constraints: { allowedPathIds: [], network: [], allowedStateEvents: [] },
    tier: "STANDARD",
    actorCalls: [],
    workflowCallCount: 0,
    retrieval: Z,
  }),
  row({
    id: "cross.no-progress",
    fixture: {
      templateId: "ulw-v1",
      parameters: { kind: "cross-case", value: "no-progress" },
      expectedTreeHash: null,
    },
    steps: [
      X("session-stop", "fixture-run", "leaf-a"),
      X("session-stop", "fixture-run", "leaf-b"),
      X("session-stop", "fixture-run", "leaf-c"),
    ],
    expected: [E("continuation-no-progress"), E("continuation-no-progress"), E("run-stuck")],
    constraints: {
      allowedPathIds: ["workflow-state"],
      network: [],
      allowedStateEvents: ["continuation", "run-stuck"],
    },
    tier: "STANDARD",
    actorCalls: [],
    workflowCallCount: 0,
    retrieval: Z,
  }),
  row({
    id: "cross.retry-isolation",
    fixture: {
      templateId: "ulw-v1",
      parameters: { kind: "cross-case", value: "retry-isolation" },
      expectedTreeHash: null,
    },
    steps: [
      X("task-result", "fixture-run", "worker-a", "semantic_mismatch"),
      X("task-result", "fixture-run", "worker-a", "semantic_mismatch"),
      X("task-result", "fixture-run", "worker-b", "accepted"),
    ],
    expected: [E("task-rejected"), E("task-rejected"), E("task-accepted")],
    constraints: {
      allowedPathIds: ["workflow-state"],
      network: [],
      allowedStateEvents: ["task-rejected", "task-escalated", "task-accepted"],
    },
    tier: "STANDARD",
    actorCalls: [],
    workflowCallCount: 0,
    retrieval: Z,
  }),
  row({
    id: "cross.legacy-migration",
    fixture: {
      templateId: "legacy-state-v1",
      parameters: { kind: "none" },
      expectedTreeHash: null,
    },
    steps: [X("interactive", "migration-status", "fixture-run")],
    expected: [E("migration-completed")],
    constraints: {
      allowedPathIds: ["legacy-state", "workflow-state"],
      network: [],
      allowedStateEvents: ["migration-completed"],
    },
    tier: "STANDARD",
    actorCalls: [],
    workflowCallCount: 0,
    retrieval: Z,
  }),
] as const satisfies readonly ScenarioAuthority[]
