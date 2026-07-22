const checks = ["test:integration:core", "test:integration:capability"] as const

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
