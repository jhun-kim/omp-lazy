import { afterEach, describe, expect, test } from "bun:test"
import { ActivationProvenanceController } from "../../src/activation/provenance-controller"
import { TransactionActivationState } from "../../src/activation/transaction-activation-state"
import { COMMAND_DEFINITIONS, COMMAND_REGISTRATIONS } from "../../src/commands/command-definitions"
import { parseWorkflowCommand } from "../../src/commands/command-parser"
import type { WorkflowCommandResult } from "../../src/commands/command-result"
import { DurableWorkflowCommandExecutor } from "../../src/commands/workflow-command-handler"
import { TransactionStore } from "../../src/state/transaction-store"
import { VALID_COMMAND_GRAMMAR_CASES } from "../fixtures/command-grammar-cases"
import { removeTestTree } from "../fixtures/remove-test-tree"
import { initializedStore, temporaryRoot } from "../fixtures/store-fixtures"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTestTree))
})

function inactiveController(): ActivationProvenanceController {
  return new ActivationProvenanceController({ isActive: async () => false })
}

describe("trusted activation provenance", () => {
  test.each([
    "interactive",
    "rpc",
  ] as const)("activates every alias from one-shot %s input", async (source) => {
    for (const registration of COMMAND_REGISTRATIONS) {
      const controller = inactiveController()
      const sessionId = `session-${registration.command}`
      const text = `please use ${registration.command.slice(1)} now`
      await controller.recordInput({ sessionId, source, text })

      expect(await controller.consumeBeforeAgentStart({ sessionId, prompt: text })).toEqual({
        kind: "activate",
        workflow: registration.workflow,
        command: registration.command,
      })
      expect(await controller.consumeBeforeAgentStart({ sessionId, prompt: text })).toEqual({
        kind: "quiet",
      })
    }
  })

  test("scopes identical text to its session and rejects reuse or hash mismatch", async () => {
    const controller = inactiveController()
    const text = "use ultrawork(omp)"
    await controller.recordInput({ sessionId: "a", source: "interactive", text })
    await controller.recordInput({ sessionId: "b", source: "interactive", text })

    expect((await controller.consumeBeforeAgentStart({ sessionId: "a", prompt: text })).kind).toBe(
      "activate",
    )
    expect(
      (await controller.consumeBeforeAgentStart({ sessionId: "b", prompt: `${text}!` })).kind,
    ).toBe("quiet")
    expect((await controller.consumeBeforeAgentStart({ sessionId: "b", prompt: text })).kind).toBe(
      "quiet",
    )
  })

  test("never arms extension input or tokenless synthetic origins for every alias", async () => {
    for (const registration of COMMAND_REGISTRATIONS) {
      const controller = inactiveController()
      const text = `activate ${registration.command.slice(1)}`
      await controller.recordInput({ sessionId: "extension", source: "extension", text })
      expect(
        await controller.consumeBeforeAgentStart({ sessionId: "extension", prompt: text }),
      ).toEqual({ kind: "quiet" })
      for (const origin of [
        "sdk",
        "headless",
        "synthetic",
        "skill",
        "continuation",
        "session_stop",
      ] as const) {
        expect(
          await controller.consumeBeforeAgentStart({ sessionId: origin, prompt: text }),
        ).toEqual({ kind: "quiet" })
      }
    }
  })

  test("rejects Unicode and filename boundary near misses", async () => {
    for (const text of [
      "bulwark",
      "ｕｌｗ",
      "ulw_plan",
      "ulw-plan(omp).md",
      "dir/ulw-loop(omp)",
      "울w",
    ]) {
      const controller = inactiveController()
      await controller.recordInput({ sessionId: text, source: "interactive", text })
      expect(await controller.consumeBeforeAgentStart({ sessionId: text, prompt: text })).toEqual({
        kind: "quiet",
      })
    }
  })

  test("rejects ambiguous text that names multiple workflows", async () => {
    const controller = inactiveController()
    const text = "use ulw(omp) and ulw-loop(omp)"
    await controller.recordInput({ sessionId: "ambiguous", source: "interactive", text })
    expect(
      await controller.consumeBeforeAgentStart({ sessionId: "ambiguous", prompt: text }),
    ).toEqual({ kind: "quiet" })
  })

  test("suppresses exact synthetic prompts without consuming unrelated trusted input", async () => {
    const controller = inactiveController()
    await controller.recordInput({ sessionId: "s", source: "interactive", text: "use ulw(omp)" })
    await controller.suppressNext({
      sessionId: "s",
      text: "continue ulw(omp)",
      reason: "continuation",
    })

    expect(
      await controller.consumeBeforeAgentStart({ sessionId: "s", prompt: "continue ulw(omp)" }),
    ).toEqual({ kind: "quiet" })
    expect(
      await controller.consumeBeforeAgentStart({ sessionId: "s", prompt: "use ulw(omp)" }),
    ).toEqual({
      kind: "activate",
      workflow: "ultrawork",
      command: "/ulw(omp)",
    })
  })

  test("consults persisted transaction state and stays quiet for an already-active workflow", async () => {
    const root = await temporaryRoot("activation-active")
    roots.push(root.displayPath)
    const { store } = await initializedStore(root)
    const controller = new ActivationProvenanceController(new TransactionActivationState(store))
    await controller.recordInput({
      sessionId: "session-a",
      source: "interactive",
      text: "start-work",
    })

    expect(
      await controller.consumeBeforeAgentStart({ sessionId: "session-a", prompt: "start-work" }),
    ).toEqual({ kind: "quiet" })
  })
})

describe("command grammar", () => {
  test.each([
    ["start_work", "status --evil"],
    ["ulw_loop", "status --evil"],
    ["teammode", "status --evil"],
    ["ulw_research", "query --evil"],
    ["contribute_bug_fix", "--dry-run issue-1 extra"],
  ] as const)("rejects verifier regression %s: %s", (workflow, args) => {
    expect(parseWorkflowCommand(workflow, args)).toEqual({
      ok: false,
      code: "invalid_grammar",
    })
  })

  test("rejects an uncatalogued flag for every authoritative workflow grammar", () => {
    for (const definition of COMMAND_DEFINITIONS) {
      expect(parseWorkflowCommand(definition.workflow, "--not-in-catalog").ok).toBeFalse()
    }
  })

  test.each(VALID_COMMAND_GRAMMAR_CASES)("preserves valid grammar %s: %s", (workflow, args) => {
    expect(parseWorkflowCommand(workflow, args).ok).toBeTrue()
  })

  test("maps convenient ULW loop forms onto typed lifecycle operations", () => {
    expect(parseWorkflowCommand("ulw_loop", "")).toEqual({
      ok: true,
      operation: "status",
      words: [],
    })
    expect(parseWorkflowCommand("ulw_loop", "테스트 작업 수행")).toEqual({
      ok: true,
      operation: "create",
      words: ["테스트", "작업", "수행"],
    })
    expect(parseWorkflowCommand("ulw_loop", "-- 테스트 작업 수행")).toEqual({
      ok: true,
      operation: "create",
      words: ["테스트", "작업", "수행"],
    })
  })

  test.each([
    "create",
    "adopt",
    "checkpoint run-1",
    "steer run-1",
  ])("rejects malformed reserved ULW loop operation: %s", (args) => {
    expect(parseWorkflowCommand("ulw_loop", args)).toEqual({
      ok: false,
      code: "invalid_grammar",
    })
  })

  test.each([
    "--",
    "objective -- tail",
    "-- -- repeated",
    "create -- x",
  ])("rejects misplaced ULW loop delimiter: %s", (args) => {
    expect(parseWorkflowCommand("ulw_loop", args)).toEqual({
      ok: false,
      code: "invalid_grammar",
    })
  })

  test("accepts authoritative forms and rejects malformed flags and positions", () => {
    expect(parseWorkflowCommand("start_work", "pause run-1").ok).toBeTrue()
    expect(parseWorkflowCommand("ultrawork", "heavy -- implement safely").ok).toBeTrue()
    expect(parseWorkflowCommand("doctor", "--json --deep").ok).toBeTrue()
    expect(parseWorkflowCommand("teammode", "").ok).toBeFalse()
    expect(parseWorkflowCommand("ulw_research", "").ok).toBeFalse()
    expect(parseWorkflowCommand("doctor", "--write").ok).toBeFalse()
    expect(parseWorkflowCommand("contribute_bug_fix", "issue-1").ok).toBeFalse()
    expect(parseWorkflowCommand("report_bug", "--target evil summary").ok).toBeFalse()
    expect(parseWorkflowCommand("report_bug", "summary --evil").ok).toBeFalse()
    expect(parseWorkflowCommand("ulw_research", "--evil query").ok).toBeFalse()
    expect(parseWorkflowCommand("start_work", 'start "unterminated').ok).toBeFalse()
  })

  test("registered command execution activates without an input token and suppresses recursion", async () => {
    const root = await temporaryRoot("command-activation")
    roots.push(root.displayPath)
    const controller = inactiveController()
    const sent: string[] = []
    const executor = new DurableWorkflowCommandExecutor({
      store: new TransactionStore(root),
      suppression: controller,
      sendUserMessage: (message) => sent.push(message),
    })
    const registration = COMMAND_REGISTRATIONS.find((entry) => entry.command === "/ulw(omp)")
    if (registration === undefined) throw new Error("missing /ulw(omp) registration")

    await executor.execute({
      registration,
      args: "heavy -- verify command activation",
      sessionId: "command-session",
      cwd: root.displayPath,
    })

    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain("workflow ultrawork")
    expect(
      await controller.consumeBeforeAgentStart({
        sessionId: "command-session",
        prompt: sent[0] ?? "",
      }),
    ).toEqual({ kind: "quiet" })
  })

  test("pause, resume, and cancel use the persisted transaction store", async () => {
    const root = await temporaryRoot("command-controls")
    roots.push(root.displayPath)
    const { store, run } = await initializedStore(root)
    const executor = new DurableWorkflowCommandExecutor({
      store,
      suppression: inactiveController(),
      sendUserMessage: () => undefined,
    })
    const registration = COMMAND_REGISTRATIONS.find((entry) => entry.command === "/start-work(omp)")
    if (registration === undefined) throw new Error("missing /start-work(omp) registration")

    for (const [args, status] of [
      ["pause", "paused"],
      ["resume", "active"],
      ["cancel", "cancelled"],
    ] as const) {
      await executor.execute({
        registration,
        args,
        sessionId: "session-a",
        cwd: root.displayPath,
      })
      const persisted = await store.readRun(run.runId)
      expect(persisted?.payload.status).toBe(status)
    }
  })

  test("a paused persisted run can be adopted by exact run id and stale ownership is fenced", async () => {
    const root = await temporaryRoot("command-adopt")
    roots.push(root.displayPath)
    const { store, run } = await initializedStore(root)
    const results: WorkflowCommandResult[] = []
    const executor = new DurableWorkflowCommandExecutor({
      store,
      suppression: inactiveController(),
      sendUserMessage: () => undefined,
      publishResult: (result) => results.push(result),
    })
    const registration = COMMAND_REGISTRATIONS.find((entry) => entry.command === "/start-work(omp)")
    if (registration === undefined) throw new Error("missing /start-work(omp) registration")
    await executor.execute({
      registration,
      args: "pause",
      sessionId: "session-a",
      cwd: root.displayPath,
    })

    await executor.execute({
      registration,
      args: `adopt ${run.runId}`,
      sessionId: "session-b",
      cwd: root.displayPath,
    })

    const adopted = await store.readRun(run.runId)
    expect(adopted?.owner).toEqual({ sessionId: "session-b", epoch: 2 })
    expect(adopted?.payload.status).toBe("active")
    await executor.execute({
      registration,
      args: `pause ${run.runId}`,
      sessionId: "session-a",
      cwd: root.displayPath,
    })
    expect(results.at(-1)).toMatchObject({ status: "BLOCKED", code: "owner_mismatch" })
    expect((await store.readRun(run.runId))?.owner).toEqual({ sessionId: "session-b", epoch: 2 })
  })

  test("Given an extension-origin lifecycle request When executed Then no state mutation is authorized", async () => {
    // Given: a current run and the direct command executor with an extension-origin request.
    const root = await temporaryRoot("command-extension-origin")
    roots.push(root.displayPath)
    const { store, run } = await initializedStore(root)
    const results: WorkflowCommandResult[] = []
    const executor = new DurableWorkflowCommandExecutor({
      store,
      suppression: inactiveController(),
      sendUserMessage: () => undefined,
      publishResult: (result) => results.push(result),
    })
    const registration = COMMAND_REGISTRATIONS.find((entry) => entry.command === "/start-work(omp)")
    if (registration === undefined) throw new Error("missing /start-work(omp) registration")

    // When: extension text attempts a trusted lifecycle control directly.
    await executor.execute({
      registration,
      args: `pause ${run.runId}`,
      sessionId: run.owner.sessionId,
      cwd: root.displayPath,
      source: "extension",
    })

    // Then: the typed refusal is visible and the run remains active at its prior revision.
    expect(results).toEqual([
      expect.objectContaining({ status: "BLOCKED", code: "extension_origin_rejected" }),
    ])
    expect((await store.readRun(run.runId))?.payload.status).toBe("active")
  })
})
