import { z } from "zod"

export type ReleaseGate = {
  readonly requirePassStatus: boolean
  readonly script: string
  readonly structured: boolean
}

export type GateProcessOutput = {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

export class ReleaseGateError extends Error {
  override readonly name = "ReleaseGateError"
}

const isolatedReceiptSchema = z.object({
  cleanup: z.object({ processTree: z.literal("complete"), sandbox: z.literal("complete") }),
  exitCode: z.literal(0),
  stdout: z.string(),
  timedOut: z.literal(false),
})

const sharedGates = [
  { requirePassStatus: false, script: "check", structured: false },
  { requirePassStatus: true, script: "verify:skills", structured: true },
  { requirePassStatus: true, script: "verify:readme", structured: true },
  { requirePassStatus: false, script: "smoke:loader", structured: true },
  { requirePassStatus: false, script: "smoke:discovery", structured: true },
  { requirePassStatus: false, script: "pack:candidate", structured: true },
  { requirePassStatus: false, script: "smoke:staged", structured: true },
  { requirePassStatus: true, script: "test:hostile", structured: true },
  { requirePassStatus: true, script: "preflight:omp", structured: true },
] as const satisfies readonly ReleaseGate[]

export function releaseGatePlan(platform: NodeJS.Platform): readonly ReleaseGate[] {
  const hostGate: ReleaseGate =
    platform === "win32"
      ? { requirePassStatus: false, script: "smoke:link:windows", structured: true }
      : { requirePassStatus: false, script: "dogfood:omp", structured: true }
  return [...sharedGates, hostGate]
}

export function verifyReleaseGateOutput(script: string, output: GateProcessOutput): void {
  if (output.exitCode !== 0) {
    throw new ReleaseGateError(`release gate failed: ${script} (${output.exitCode})`)
  }
  if (output.stdout.trim().length === 0) {
    throw new ReleaseGateError(`release gate emitted empty evidence: ${script}`)
  }
  const gate = releaseGatePlan(process.platform).find((candidate) => candidate.script === script)
  if (gate?.structured !== true) return
  const outer = isolatedReceiptSchema.parse(JSON.parse(output.stdout))
  if (outer.stdout.trim().length === 0) {
    throw new ReleaseGateError(`release gate emitted empty evidence: ${script}`)
  }
  const inner: unknown = JSON.parse(outer.stdout)
  if (gate.requirePassStatus) {
    const status = z
      .object({ status: z.literal("PASS") })
      .passthrough()
      .safeParse(inner)
    if (!status.success) throw new ReleaseGateError(`release gate did not report PASS: ${script}`)
  }
}
