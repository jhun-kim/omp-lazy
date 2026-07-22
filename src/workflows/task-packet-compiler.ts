import { relative } from "node:path"
import type { AgentMessage } from "@oh-my-pi/pi-agent-core"
import {
  type CompiledTaskPacket,
  classifyTaskTier,
  compileTaskPacket,
  type TaskPacketCompileResult,
  type TaskPacketInput,
  TierBudgets,
} from "../contracts/task-packet"
import type { AnyRun, Criterion } from "../state/domain"
import { parseStartWorkPlan } from "./start-work-plan"

export const TASK_PACKET_CUSTOM_TYPE = "omp-lazy-task-packet"

export type TaskPacketMessage = {
  readonly customType: typeof TASK_PACKET_CUSTOM_TYPE
  readonly content: string
  readonly display: false
  readonly details: {
    readonly version: 1
    readonly packetHash: string
    readonly packetBytes: number
    readonly runId: string
    readonly taskId: string
    readonly generation: number
    readonly tier: CompiledTaskPacket["packet"]["tier"]
  }
}

export type StepContextCompileResult =
  | {
      readonly ok: true
      readonly compiled: CompiledTaskPacket
      readonly message: TaskPacketMessage
    }
  | Extract<TaskPacketCompileResult, { readonly ok: false }>

type PacketCriterion = TaskPacketInput["criteria"][number]

function relativePlanPath(repositoryRoot: string, displayPath: string): string {
  return relative(repositoryRoot, displayPath).replaceAll("\\", "/")
}

function planTaskBlock(markdown: string, taskId: string): readonly string[] {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n")
  const start = lines.findIndex((line) => line.startsWith(`- [ ] **${taskId}. `))
  if (start < 0) return []
  const next = lines.findIndex((line, index) => index > start && /^- \[[ xX]\] /u.test(line))
  return lines.slice(start, next < 0 ? undefined : next)
}

function remainingTaskId(markdown: string, declaredIds: readonly string[]): string | null {
  const snapshot = parseStartWorkPlan(markdown)
  const normalized = snapshot.remainingTaskIds.find((taskId) => declaredIds.includes(taskId))
  if (normalized !== undefined) return normalized
  for (const line of markdown.replaceAll("\r\n", "\n").split("\n")) {
    const match = /^- \[ \] \*\*([A-Z][A-Z0-9-]{0,31})\. /u.exec(line)
    const taskId = match?.[1]
    if (taskId !== undefined && declaredIds.includes(taskId)) return taskId
  }
  return null
}

function field(block: readonly string[], label: string): string | null {
  const prefix = `  - **${label}:** `
  return (
    block
      .find((line) => line.startsWith(prefix))
      ?.slice(prefix.length)
      .trim() ?? null
  )
}

function taskTitle(block: readonly string[], taskId: string): string {
  const line = block[0]
  const prefix = `- [ ] **${taskId}. `
  return line?.startsWith(prefix) && line.endsWith("**")
    ? line.slice(prefix.length, -2).trim()
    : taskId
}

function referencedPaths(block: readonly string[]): readonly string[] {
  const references = field(block, "References")
  if (references === null) return []
  const paths = [...references.matchAll(/`([^`]+)`/gu)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined)
    .map((value) => value.replace(/:\d+(?:-\d+)?$/u, ""))
    .filter(
      (value) =>
        !value.includes("{") &&
        !value.includes("}") &&
        !value.includes("*") &&
        !value.includes("://") &&
        !value.startsWith("/") &&
        !value.split(/[\\/]/u).includes(".."),
    )
    .map((value) => value.replaceAll("\\", "/"))
  return [...new Set(paths)].sort()
}

function criterionForTask(taskId: string, acceptance: string): PacketCriterion {
  return {
    id: "acceptance",
    scenario: `Complete ${taskId}`,
    observable: acceptance,
    expected: acceptance,
    evidenceLogicalId: `${taskId}.result`,
  }
}

function criterionForGoal(taskId: string, criterion: Criterion): PacketCriterion {
  const evidenceLogicalId = criterion.evidenceLogicalId ?? `${taskId}.${criterion.id}`
  const observable = criterion.observable ?? criterion.scenario ?? criterion.id
  return {
    id: criterion.id,
    scenario: criterion.scenario ?? observable,
    observable,
    expected: observable,
    evidenceLogicalId,
  }
}

export function compileRunStepContext(input: {
  readonly run: AnyRun
  readonly repositoryRoot: string
  readonly planMarkdown: string | null
}): StepContextCompileResult | null {
  const { run } = input
  if (run.payload.status !== "active") return null
  if (run.workflow === "start_work") {
    if (input.planMarkdown === null) return null
    const taskId = remainingTaskId(input.planMarkdown, run.payload.plan.taskIds)
    if (taskId === null) return null
    const block = planTaskBlock(input.planMarkdown, taskId)
    const fallbackPath = relativePlanPath(input.repositoryRoot, run.payload.plan.displayPath)
    const allowedPaths = referencedPaths(block)
    const packetPaths = allowedPaths.length > 0 ? allowedPaths : [fallbackPath]
    const acceptance = field(block, "Acceptance") ?? `The ${taskId} plan step is complete.`
    const criteria = [criterionForTask(taskId, acceptance)]
    const tier = classifyTaskTier({
      allowedPaths: packetPaths,
      boundaryTags: ["none"],
      publicBehavior: false,
    })
    return compileStepContext({
      version: 1,
      runId: run.runId,
      taskId,
      generation: Math.max(1, run.revision),
      objective: taskTitle(block, taskId),
      deliverable: field(block, "Implementation") ?? acceptance,
      allowedPaths: packetPaths,
      referenceIds: [`plan:${taskId}`],
      dependencyIds: [],
      criteria,
      boundaryTags: ["none"],
      publicBehavior: false,
      tier,
      budgets: TierBudgets[tier],
      evidenceRequirements: criteria.map((criterion) => ({
        logicalId: criterion.evidenceLogicalId,
        kind: "test" as const,
        required: true,
      })),
    })
  }

  const goal = run.payload.goals.find((candidate) => candidate.id === run.payload.activeGoalId)
  if (goal === undefined || goal.criteria.length === 0) return null
  const criteria = goal.criteria
    .slice(0, 6)
    .map((criterion) => criterionForGoal(goal.id, criterion))
  return compileStepContext({
    version: 1,
    runId: run.runId,
    taskId: goal.id,
    generation: Math.max(1, run.revision),
    objective: run.payload.objective ?? goal.id,
    deliverable: run.payload.annotation ?? `Settle every criterion for ${goal.id}.`,
    allowedPaths: [],
    referenceIds: [],
    dependencyIds: [],
    criteria,
    boundaryTags: ["none"],
    publicBehavior: false,
    tier: "FAST",
    budgets: TierBudgets.FAST,
    evidenceRequirements: criteria.map((criterion) => ({
      logicalId: criterion.evidenceLogicalId,
      kind: "test" as const,
      required: true,
    })),
  })
}

export function compileStepContext(input: unknown): StepContextCompileResult {
  const compiled = compileTaskPacket(input)
  if (!compiled.ok) return compiled
  return {
    ok: true,
    compiled,
    message: {
      customType: TASK_PACKET_CUSTOM_TYPE,
      content: compiled.canonicalJson,
      display: false,
      details: {
        version: 1,
        packetHash: compiled.packetHash,
        packetBytes: compiled.packetBytes,
        runId: compiled.packet.runId,
        taskId: compiled.packet.taskId,
        generation: compiled.packet.generation,
        tier: compiled.packet.tier,
      },
    },
  }
}

export function compilePromptStepContext(prompt: string): StepContextCompileResult | null {
  if (Buffer.byteLength(prompt, "utf8") > TierBudgets.DEEP.maxPacketBytes) return null
  let value: unknown
  try {
    value = JSON.parse(prompt)
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
  return compileStepContext(value)
}

export function compactStepContext(
  messages: readonly AgentMessage[],
  current: TaskPacketMessage | null,
  timestamp: number,
): AgentMessage[] {
  const compacted = messages.filter(
    (message) => message.role !== "custom" || message.customType !== TASK_PACKET_CUSTOM_TYPE,
  )
  if (current === null) return compacted
  return [...compacted, { ...current, role: "custom", timestamp }]
}
