import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader"
import {
  cleanupWorkflowRoots,
  publicWorkflowRuntime,
  workflowPlan,
  workflowRepository,
} from "../fixtures/workflow-lifecycle-fixtures"

afterEach(async () => {
  await cleanupWorkflowRoots()
})

describe("typed workflow lifecycle public surface", () => {
  test("Given an unchanged non-lifecycle command When invoked Then it retains one model activation", async () => {
    // Given: the public product extension and a clean repository.
    const root = await workflowRepository("activation-baseline")
    const loaded = await loadExtensions([join(process.cwd(), "src", "index.ts")], process.cwd())
    const extension = loaded.extensions[0]
    const command = extension?.commands.get("ultrawork(omp)")
    if (command === undefined) throw new Error("ultrawork command missing")
    const messages: string[] = []
    loaded.runtime.sendUserMessage = (content) => {
      if (typeof content === "string") messages.push(content)
    }

    // When: the legacy model-driven activation command runs.
    await command.handler("heavy -- preserve activation", {
      cwd: root,
      sessionManager: { getSessionId: () => "parent-session" },
    } as Parameters<typeof command.handler>[1])

    // Then: exactly one activation prompt is delivered, preserving the baseline contract.
    expect(messages).toHaveLength(1)
    expect(messages[0]).toBe("Activate omp-lazy workflow ultrawork: heavy -- preserve activation")
  })

  test("Given an approved v2 plan When start and status run Then lifecycle persists without a model turn", async () => {
    // Given: a clean repository and a trusted approval command for exact plan bytes.
    const root = await workflowRepository("start-happy")
    const path = join(root, ".omo", "plans", "work.md")
    await mkdir(join(root, ".omo", "plans"), { recursive: true })
    await writeFile(path, workflowPlan)
    const hash = createHash("sha256").update(workflowPlan).digest("hex")
    const runtime = await publicWorkflowRuntime(root)

    // When: approval, start, and status execute through registered commands.
    await runtime.invoke("ulw-plan(omp)", `approve .omo/plans/work.md ${hash}`)
    await runtime.invoke("start-work(omp)", "start .omo/plans/work.md")
    await runtime.invoke("start-work(omp)", "status")

    // Then: all operations are typed PASS results with one durable run and no model prompt.
    expect(runtime.results.map((result) => [result.operation, result.status])).toEqual([
      ["approve", "PASS"],
      ["start", "PASS"],
      ["status", "PASS"],
    ])
    expect(runtime.results[1]?.runId).toBeString()
    expect(runtime.results[2]?.runId).toBe(runtime.results[1]?.runId)
    expect(runtime.prompts).toEqual([])
  })

  test("Given a ULW run When created, steered, and checkpointed without acceptance Then scope rejects safely", async () => {
    // Given: a direct ULW run and a contained steering document.
    const root = await workflowRepository("ulw-lifecycle")
    const runtime = await publicWorkflowRuntime(root)
    await runtime.invoke("ulw-loop(omp)", "create finish the fixture")
    const created = runtime.results[0]
    if (created?.runId === null || created?.runId === undefined || created.revision === null) {
      throw new Error("ULW create result missing scope")
    }
    const head = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"]).stdout.toString().trim()
    const steeringPath = join(root, ".omo", "steering.json")
    await mkdir(join(root, ".omo"), { recursive: true })
    await writeFile(
      steeringPath,
      JSON.stringify({
        version: 1,
        runId: created.runId,
        expectedRevision: created.revision,
        expectedHead: head,
        idempotencyKey: "steer-1",
        addCriteria: [
          {
            id: "criterion-2",
            scenario: "fixture",
            observable: "typed result",
            evidenceLogicalId: "fixture.result",
          },
        ],
      }),
    )

    // When: steering runs and checkpoint targets evidence the parent never accepted.
    await runtime.invoke("ulw-loop(omp)", `steer ${created.runId} .omo/steering.json`)
    await runtime.invoke(
      "ulw-loop(omp)",
      `checkpoint ${created.runId} criterion-2 .omo/unaccepted.json`,
    )

    // Then: steer mutates directly while checkpoint cannot forge criterion PASS.
    expect(runtime.results[1]).toMatchObject({ operation: "steer", status: "PASS" })
    expect(runtime.results[2]).toMatchObject({
      operation: "checkpoint",
      status: "BLOCKED",
      code: "task_scope_mismatch",
    })
    expect(runtime.prompts).toEqual([])
  })

  test("Given one active objective When create replays Then exact input no-ops and conflicting input rejects", async () => {
    // Given: one direct ULW create persisted for the parent session.
    const root = await workflowRepository("ulw-replay")
    const runtime = await publicWorkflowRuntime(root)
    await runtime.invoke("ulw-loop(omp)", "create stable objective")
    const first = runtime.results[0]

    // When: the parent repeats the same create and then changes its semantic objective.
    await runtime.invoke("ulw-loop(omp)", "create stable objective")
    await runtime.invoke("ulw-loop(omp)", "create conflicting objective")

    // Then: the replay retains identity while conflicting reuse is blocked without a model prompt.
    expect(runtime.results[1]).toMatchObject({ status: "PASS", runId: first?.runId })
    expect(runtime.results[2]).toMatchObject({
      status: "BLOCKED",
      code: "idempotency_conflict",
    })
    expect(runtime.prompts).toEqual([])
  }, 30_000)

  test("Given steering bound to another Git head When invoked Then the current run remains unchanged", async () => {
    // Given: a current ULW run and a steering document carrying a stale HEAD binding.
    const root = await workflowRepository("ulw-stale-head")
    const runtime = await publicWorkflowRuntime(root)
    await runtime.invoke("ulw-loop(omp)", "create protect the head")
    const created = runtime.results[0]
    if (created?.runId === null || created?.runId === undefined || created.revision === null) {
      throw new Error("ULW create result missing scope")
    }
    await mkdir(join(root, ".omo"), { recursive: true })
    await writeFile(
      join(root, ".omo", "stale-steering.json"),
      JSON.stringify({
        version: 1,
        runId: created.runId,
        expectedRevision: created.revision,
        expectedHead: "0".repeat(40),
        idempotencyKey: "stale-head",
        addCriteria: [],
      }),
    )

    // When: the trusted steer command checks the stale document.
    await runtime.invoke("ulw-loop(omp)", `steer ${created.runId} .omo/stale-steering.json`)

    // Then: HEAD CAS rejects before mutation and no model prompt is emitted.
    expect(runtime.results[1]).toMatchObject({ status: "BLOCKED", code: "stale_head" })
    expect(runtime.prompts).toEqual([])
  })

  test("Given a contained team roster When prepared and created Then controls are coordinator-owned", async () => {
    // Given: an active parent run and a non-overlapping two-member roster.
    const root = await workflowRepository("team-lifecycle")
    const runtime = await publicWorkflowRuntime(root)
    await runtime.invoke("ulw-loop(omp)", "create coordinate the fixture")
    const rosterPath = join(root, ".omo", "team.json")
    await mkdir(join(root, ".omo"), { recursive: true })
    await writeFile(
      rosterPath,
      JSON.stringify({
        teamName: "alpha",
        members: [
          {
            requestedName: "alpha-one",
            agentType: "omp-lazy-worker-low",
            focus: "first slice",
            ownership: ["src/one"],
            deliverable: "first result",
            isolated: false,
          },
          {
            requestedName: "alpha-two",
            agentType: "omp-lazy-worker-low",
            focus: "second slice",
            ownership: ["src/two"],
            deliverable: "second result",
            isolated: false,
          },
        ],
      }),
    )

    // When: trusted team commands prepare, consume, inspect, cancel, archive, and delete.
    await runtime.invoke("teammode(omp)", "prepare alpha .omo/team.json")
    const reservationId = runtime.results[1]?.runId
    if (reservationId === null || reservationId === undefined)
      throw new Error("reservation missing")
    await runtime.invoke("teammode(omp)", `create alpha ${reservationId}`)
    await runtime.invoke("teammode(omp)", "status alpha")
    await runtime.invoke("teammode(omp)", "cancel alpha")
    await runtime.invoke("teammode(omp)", "archive alpha")
    await runtime.invoke("teammode(omp)", "delete alpha")

    // Then: each transition is typed and no lifecycle command creates a model prompt.
    expect(runtime.results.slice(1).map((result) => result.operation)).toEqual([
      "prepare",
      "create",
      "status",
      "cancel",
      "archive",
      "delete",
    ])
    expect(runtime.results.slice(1).every((result) => result.status === "PASS")).toBeTrue()
    expect(runtime.prompts).toEqual([])
  })
})
