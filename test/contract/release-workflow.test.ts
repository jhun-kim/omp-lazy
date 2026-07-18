import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { repositoryRoot } from "../fixtures/package-test-helpers"

const stepSchema = z.union([
  z.strictObject({ name: z.string(), uses: z.string() }),
  z.strictObject({ name: z.string(), run: z.string() }),
  z.strictObject({
    name: z.string(),
    uses: z.string(),
    with: z.record(z.string(), z.unknown()),
  }),
])
const workflowSchema = z.object({
  jobs: z.object({
    "verify-release": z.object({
      permissions: z.never().optional(),
      runsOn: z.never().optional(),
      "runs-on": z.string(),
      steps: z.array(stepSchema),
      strategy: z.object({ matrix: z.object({ os: z.array(z.string()) }) }),
    }),
  }),
  permissions: z.strictObject({ contents: z.literal("read") }),
})

describe("release verification workflow", () => {
  it("pins Bun and runs the locked authoritative gate on Windows and Linux", async () => {
    // Given
    const source = await readFile(
      join(repositoryRoot, ".github", "workflows", "release-verification.yml"),
      "utf8",
    )

    // When
    const workflow = workflowSchema.parse(Bun.YAML.parse(source))
    const job = workflow.jobs["verify-release"]

    // Then
    expect(job.strategy.matrix.os).toEqual(["ubuntu-latest", "windows-latest"])
    expect(job.steps).toEqual([
      { name: "Check out committed source", uses: "actions/checkout@v4" },
      {
        name: "Install Bun 1.3.14",
        uses: "oven-sh/setup-bun@v2",
        with: { "bun-version": "1.3.14" },
      },
      { name: "Install locked dependencies", run: "bun install --frozen-lockfile" },
      {
        name: "Run source, staged, hostile, and pinned-host gates",
        run: "bun run verify:release",
      },
    ])
  })
})
