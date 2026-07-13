import type { WorkflowActivationId } from "../activation/types"

export type CommandDefinition = {
  readonly workflow: WorkflowActivationId
  readonly canonical: `/${string}`
  readonly aliases: readonly `/${string}`[]
  readonly description: string
  readonly grammar: readonly string[]
}

export const COMMAND_DEFINITIONS = [
  {
    workflow: "teammode",
    canonical: "/omp-lazy-teammode",
    aliases: ["/teammode"],
    description: "Manage an OMP-native durable team",
    grammar: [
      "create <team-name>",
      "status [team-name]",
      "archive <team-name>",
      "delete <team-name>",
      "resume <team-name>",
    ],
  },
  {
    workflow: "start_work",
    canonical: "/omp-lazy-start-work",
    aliases: ["/start-work"],
    description: "Start or control evidence-bound plan execution",
    grammar: [
      "",
      "start [plan-path]",
      "status [run-id]",
      "pause [run-id]",
      "resume [run-id]",
      "cancel [run-id]",
      "adopt <run-id>",
      "reconcile <run-id> <plan-path>",
      "status --repair <run-id>",
      "status --repair-lock <nonce> --confirm",
    ],
  },
  {
    workflow: "ultrawork",
    canonical: "/omp-lazy-ultrawork",
    aliases: ["/ultrawork", "/ulw"],
    description: "Activate rigorous ultrawork execution",
    grammar: ["[auto|light|heavy] [-- <task-text>]"],
  },
  {
    workflow: "ulw_loop",
    canonical: "/omp-lazy-ulw-loop",
    aliases: ["/ulw-loop"],
    description: "Run or control a bounded ULW goal-independent loop",
    grammar: [
      "create <objective-text>",
      "status [run-id]",
      "pause [run-id]",
      "resume [run-id]",
      "cancel [run-id]",
      "adopt <run-id>",
      "checkpoint <run-id> <criterion-id> <evidence-path>",
      "steer <run-id> <steering-json-path>",
    ],
  },
  {
    workflow: "ulw_plan",
    canonical: "/omp-lazy-ulw-plan",
    aliases: ["/ulw-plan"],
    description: "Create or resume a decision-complete plan",
    grammar: ["[-- <brief>]"],
  },
  {
    workflow: "ulw_research",
    canonical: "/omp-lazy-ulw-research",
    aliases: ["/ulw-research"],
    description: "Run evidence-saturated research",
    grammar: ["<query-text>"],
  },
  {
    workflow: "doctor",
    canonical: "/omp-lazy-doctor",
    aliases: ["/lcx-doctor"],
    description: "Diagnose omp-lazy without mutation",
    grammar: ["[--json] [--deep]"],
  },
  {
    workflow: "report_bug",
    canonical: "/omp-lazy-report-bug",
    aliases: ["/lcx-report-bug"],
    description: "Draft a local bug report",
    grammar: ["[--target auto|omp-lazy|omp] [--dry-run] <summary-text>"],
  },
  {
    workflow: "contribute_bug_fix",
    canonical: "/omp-lazy-contribute-bug-fix",
    aliases: ["/lcx-contribute-bug-fix"],
    description: "Run the dry-run contribution workflow",
    grammar: ["--dry-run <issue-or-bug-ref>"],
  },
] as const satisfies readonly CommandDefinition[]

export type CommandRegistration = {
  readonly command: `/${string}`
  readonly workflow: WorkflowActivationId
  readonly definition: CommandDefinition
}

export const COMMAND_REGISTRATIONS: readonly CommandRegistration[] = COMMAND_DEFINITIONS.flatMap(
  (definition) =>
    [definition.canonical, ...definition.aliases].map((command) => ({
      command,
      workflow: definition.workflow,
      definition,
    })),
)
