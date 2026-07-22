import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import { runProbeCommand } from "../../scripts/probe-harness-capability"
import { repositoryRoot } from "../fixtures/package-test-helpers"

describe("capability probe child runner", () => {
  it("completes when an unused child writes beyond pipe capacity to both streams", async () => {
    // Given: a child that fills stdout and stderr beyond Windows pipe capacity.
    const command = ["bun", join(repositoryRoot, "test", "fixtures", "probe-pipe-backpressure.ts")]

    // When: the capability runner does not need the child output.
    const startedAt = performance.now()
    const result = await runProbeCommand({
      command,
      cwd: repositoryRoot,
      environment: {},
      timeoutMs: 1_000,
    })

    // Then: stream backpressure cannot force the bounded command timeout.
    expect(result.exitCode).toBe(0)
    expect(performance.now() - startedAt).toBeLessThan(350)
  }, 5_000)
})
