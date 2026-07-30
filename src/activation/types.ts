export type WorkflowActivationId =
  | "teammode"
  | "start_work"
  | "ultrawork"
  | "ulw_loop"
  | "ulw_plan"
  | "ulw_deliver"
  | "ulw_research"
  | "doctor"
  | "report_bug"
  | "contribute_bug_fix"

export type TrustedInputSource = "interactive" | "rpc" | "extension"
export type SuppressionReason = "command" | "continuation" | "skill" | "synthetic"

export type ActivationInput = {
  readonly sessionId: string
  readonly source: TrustedInputSource
  readonly text: string
}

export type BeforeAgentStartInput = {
  readonly sessionId: string
  readonly prompt: string
}

export type ActivationDecision =
  | { readonly kind: "quiet" }
  | {
      readonly kind: "activate"
      readonly workflow: WorkflowActivationId
      readonly command: `/${string}`
    }

export interface ActivationStatePort {
  isActive(workflow: WorkflowActivationId, sessionId: string): Promise<boolean>
  isDirectiveAlreadyActivated?(
    sessionId: string,
    workflow: WorkflowActivationId,
    currentRunId: string | null,
  ): Promise<boolean>
  currentRunId?(sessionId: string): Promise<string | null>
  recordDirectiveActivation?(
    sessionId: string,
    workflow: WorkflowActivationId,
    runId: string | null,
  ): Promise<void>
  clearDirectiveActivation?(sessionId: string): Promise<void>
}

export interface ActivationSuppressionPort {
  suppressNext(request: {
    readonly sessionId: string
    readonly text: string
    readonly reason: SuppressionReason
  }): Promise<void>
  runCommand<T>(sessionId: string, operation: () => Promise<T>): Promise<T>
}
