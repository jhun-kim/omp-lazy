import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ActivationProvenanceController } from "../../src/activation/provenance-controller"
import { TransactionActivationState } from "../../src/activation/transaction-activation-state"
import { directiveActivationPath, statePaths } from "../../src/state/paths"
import { TransactionStore } from "../../src/state/transaction-store"
import { removeTestTree } from "../fixtures/remove-test-tree"
import { initializedStore, temporaryRoot } from "../fixtures/store-fixtures"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTestTree))
})

describe("directive activation idempotency – per session and run", () => {
  test("three consecutive triggering prompts inject only once", async () => {
    const root = await temporaryRoot("idempotent-inject-once")
    roots.push(root.displayPath)
    const { store, run } = await initializedStore(root)
    const state = new TransactionActivationState(store)
    const controller = new ActivationProvenanceController(state)

    const sessionId = run.owner.sessionId
    const text = "ultrawork heavy mode"

    // First prompt: should activate
    await controller.recordInput({ sessionId, source: "interactive", text })
    const first = await controller.consumeBeforeAgentStart({ sessionId, prompt: text })
    expect(first.kind).toBe("activate")

    // Record the activation durably (as the real handler does after resolving the directive)
    const currentRunId = await state.currentRunId(sessionId)
    await state.recordDirectiveActivation(sessionId, "ultrawork", currentRunId)

    // Second prompt: same session, same run → should be quiet (idempotent)
    await controller.recordInput({ sessionId, source: "interactive", text })
    const second = await controller.consumeBeforeAgentStart({ sessionId, prompt: text })
    expect(second.kind).toBe("quiet")

    // Third prompt: same session, same run → still quiet
    await controller.recordInput({ sessionId, source: "interactive", text })
    const third = await controller.consumeBeforeAgentStart({ sessionId, prompt: text })
    expect(third.kind).toBe("quiet")
  })

  test("a new run id allows re-injection", async () => {
    const root = await temporaryRoot("idempotent-new-run")
    roots.push(root.displayPath)
    const { store, run } = await initializedStore(root)
    const state = new TransactionActivationState(store)
    const controller = new ActivationProvenanceController(state)

    const sessionId = run.owner.sessionId
    const text = "ultrawork heavy mode"

    // First activation with current run
    await controller.recordInput({ sessionId, source: "interactive", text })
    const first = await controller.consumeBeforeAgentStart({ sessionId, prompt: text })
    expect(first.kind).toBe("activate")

    // Record with the current run id
    const currentRunId = await state.currentRunId(sessionId)
    expect(currentRunId).toBe(run.runId)
    await state.recordDirectiveActivation(sessionId, "ultrawork", currentRunId)

    // Verify idempotency holds with same run
    await controller.recordInput({ sessionId, source: "interactive", text })
    const suppressed = await controller.consumeBeforeAgentStart({ sessionId, prompt: text })
    expect(suppressed.kind).toBe("quiet")

    // Now simulate a new run by writing a record with a different run id
    // In the real system, the active-index entry would change, giving a different currentRunId
    // We simulate by directly updating the record to have an old run id
    // and then the currentRunId check will see the mismatch
    const oldRunId = "00000000-0000-4000-8000-000000000000"
    await state.recordDirectiveActivation(sessionId, "ultrawork", oldRunId)

    // Now the current run id (from index) differs from the record's run id → allow re-injection
    await controller.recordInput({ sessionId, source: "interactive", text })
    const reinjected = await controller.consumeBeforeAgentStart({ sessionId, prompt: text })
    expect(reinjected.kind).toBe("activate")
  })

  test("a simulated compaction/reload preserves the durable record", async () => {
    const root = await temporaryRoot("idempotent-reload")
    roots.push(root.displayPath)
    const { store, run } = await initializedStore(root)
    const state = new TransactionActivationState(store)
    const controller = new ActivationProvenanceController(state)

    const sessionId = run.owner.sessionId
    const text = "ultrawork heavy mode"

    // Activate and record
    await controller.recordInput({ sessionId, source: "interactive", text })
    const first = await controller.consumeBeforeAgentStart({ sessionId, prompt: text })
    expect(first.kind).toBe("activate")
    await state.recordDirectiveActivation(sessionId, "ultrawork", run.runId)

    // Simulate a reload by creating a fresh TransactionActivationState on the same root
    const freshStore = new TransactionStore(root)
    const freshState = new TransactionActivationState(freshStore)
    const freshController = new ActivationProvenanceController(freshState)

    // The record should still suppress activation (survived the reload)
    await freshController.recordInput({ sessionId, source: "interactive", text })
    const afterReload = await freshController.consumeBeforeAgentStart({ sessionId, prompt: text })
    expect(afterReload.kind).toBe("quiet")

    // And the record is readable
    const record = await freshState.readDirectiveActivation(sessionId)
    expect(record).not.toBeNull()
    expect(record?.workflow).toBe("ultrawork")
    expect(record?.runId).toBe(run.runId)
    expect(record?.schemaVersion).toBe(2)
  })

  test("explicit command invocation clears the record and allows re-injection", async () => {
    const root = await temporaryRoot("idempotent-command-clear")
    roots.push(root.displayPath)
    const { store, run } = await initializedStore(root)
    const state = new TransactionActivationState(store)
    const controller = new ActivationProvenanceController(state)

    const sessionId = run.owner.sessionId
    const text = "ultrawork heavy mode"

    // Activate and record
    await controller.recordInput({ sessionId, source: "interactive", text })
    const first = await controller.consumeBeforeAgentStart({ sessionId, prompt: text })
    expect(first.kind).toBe("activate")
    await state.recordDirectiveActivation(sessionId, "ultrawork", run.runId)

    // Verify suppression
    await controller.recordInput({ sessionId, source: "interactive", text })
    const suppressed = await controller.consumeBeforeAgentStart({ sessionId, prompt: text })
    expect(suppressed.kind).toBe("quiet")

    // Simulate explicit command invocation clearing the record
    await controller.runCommand(sessionId, async () => {
      // noop - the clearing happens inside runCommand
    })

    // After command clears the record, re-injection should be allowed
    await controller.recordInput({ sessionId, source: "interactive", text })
    const reinjected = await controller.consumeBeforeAgentStart({ sessionId, prompt: text })
    expect(reinjected.kind).toBe("activate")
  })

  test("corrupted activation record allows fresh activation without duplicate injection", async () => {
    const root = await temporaryRoot("idempotent-corrupted")
    roots.push(root.displayPath)
    const { store, run } = await initializedStore(root)
    const state = new TransactionActivationState(store)
    const controller = new ActivationProvenanceController(state)

    const sessionId = run.owner.sessionId
    const paths = statePaths(root)

    // Write a corrupted record
    await mkdir(join(paths.root, "directive-activations"), { recursive: true })
    const recordPath = directiveActivationPath(root, sessionId)
    await writeFile(recordPath, "{{{{not valid json!!!")

    // The system should treat corrupted as absent and allow ONE fresh activation
    const text = "ultrawork heavy mode"
    await controller.recordInput({ sessionId, source: "interactive", text })
    const decision = await controller.consumeBeforeAgentStart({ sessionId, prompt: text })
    expect(decision.kind).toBe("activate")

    // Record the new activation
    await state.recordDirectiveActivation(sessionId, "ultrawork", run.runId)

    // Subsequent prompts should be quiet (no duplicate)
    await controller.recordInput({ sessionId, source: "interactive", text })
    const second = await controller.consumeBeforeAgentStart({ sessionId, prompt: text })
    expect(second.kind).toBe("quiet")
  })

  test("unknown workflow id in record still prevents duplicate for same workflow", async () => {
    const root = await temporaryRoot("idempotent-unknown-workflow")
    roots.push(root.displayPath)
    const { store, run } = await initializedStore(root)
    const state = new TransactionActivationState(store)

    const sessionId = run.owner.sessionId
    const paths = statePaths(root)

    // Write a record with a legitimate but different workflow
    await mkdir(join(paths.root, "directive-activations"), { recursive: true })
    await writeFile(
      directiveActivationPath(root, sessionId),
      JSON.stringify({
        schemaVersion: 2,
        sessionId,
        workflow: "ulw_plan",
        runId: run.runId,
        activatedAt: new Date().toISOString(),
      }),
    )

    // A different workflow than what's recorded should still activate
    const alreadyUlwPlan = await state.isDirectiveAlreadyActivated(sessionId, "ulw_plan", run.runId)
    expect(alreadyUlwPlan).toBe(true)

    const alreadyUltrawork = await state.isDirectiveAlreadyActivated(
      sessionId,
      "ultrawork",
      run.runId,
    )
    expect(alreadyUltrawork).toBe(false)
  })
})
