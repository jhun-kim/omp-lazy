import { publicReleaseGateOutput, releaseGatePlan } from "./release-gates"

async function run(script: string): Promise<void> {
  const child = Bun.spawn(["bun", "run", script], {
    cwd: process.cwd(),
    stderr: "pipe",
    stdout: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  process.stdout.write(publicReleaseGateOutput(script, { exitCode, stderr, stdout }))
}

// no-excuse-ok: catch -- release CLI must stop at the first failed mandatory gate.
try {
  for (const gate of releaseGatePlan(process.platform)) await run(gate.script)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
