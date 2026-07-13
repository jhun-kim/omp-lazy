const checks = ["typecheck", "lint", "test:unit", "test:contract", "test:integration"] as const

for (const check of checks) {
  const child = Bun.spawn(["bun", "run", check], {
    cwd: process.cwd(),
    stderr: "inherit",
    stdout: "inherit",
  })
  const exitCode = await child.exited
  if (exitCode !== 0) {
    process.exitCode = exitCode
    break
  }
}
