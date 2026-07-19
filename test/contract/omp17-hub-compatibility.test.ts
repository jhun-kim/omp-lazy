import { describe, expect, test } from "bun:test"
import { expectedOmpVersion } from "../../scripts/omp-executable"
import { authorizeImmutableToolCall } from "../../src/gates/immutable-tool-authorization"
import { checkTaskSurfaces } from "../../src/observers/tool-result-observer"

describe("OMP 17 hub compatibility", () => {
  test("Given OMP 17 surfaces When capability is checked Then task and hub are required", () => {
    expect(checkTaskSurfaces(["task", "hub"])).toEqual({ status: "surface_available" })
    expect(checkTaskSurfaces(["task", "job", "irc"])).toEqual({
      status: "blocked",
      reason: "task_or_hub_surface_missing",
    })
  })

  test("Given hub job operations When authorized Then they preserve immutable job controls", () => {
    expect(
      authorizeImmutableToolCall({
        toolName: "hub",
        toolCallId: "hub-jobs",
        input: { op: "jobs" },
      }),
    ).toMatchObject({ kind: "job", control: { control: "job_snapshot", targets: [] } })
    expect(
      authorizeImmutableToolCall({
        toolName: "hub",
        toolCallId: "hub-cancel",
        input: { op: "cancel", ids: ["worker-1"] },
      }),
    ).toMatchObject({
      kind: "job",
      control: { control: "job_cancel", targets: ["worker-1"] },
    })
  })

  test("Given hub messaging When authorized Then recipient ownership is preserved", () => {
    expect(
      authorizeImmutableToolCall({
        toolName: "hub",
        toolCallId: "hub-send",
        input: { op: "send", to: "worker-1", message: "status" },
      }),
    ).toMatchObject({ kind: "irc", control: { kind: "send", targets: ["worker-1"] } })
  })

  test("Given a unified hub wait When authorized Then job and peer targets remain distinct", () => {
    expect(
      authorizeImmutableToolCall({
        toolName: "hub",
        toolCallId: "hub-wait",
        input: { op: "wait", ids: ["job-1"], from: "agent-1", timeoutMs: 1000 },
      }),
    ).toMatchObject({
      kind: "hub_wait",
      control: { agentTargets: ["agent-1"], jobTargets: ["job-1"] },
    })
  })

  test("Given the release toolchain When inspected Then OMP 17.0.5 is pinned", () => {
    expect(expectedOmpVersion).toBe("17.0.5")
  })
})
