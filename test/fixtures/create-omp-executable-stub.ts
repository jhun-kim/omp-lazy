import { chmod, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

export type OmpExecutableStub = {
  readonly argvLog: string
  readonly executable: string
}

class OmpExecutableStubError extends Error {
  override readonly name = "OmpExecutableStubError"
}

export async function createOmpExecutableStub(root: string): Promise<OmpExecutableStub> {
  const runtime = join(root, "Outdated OMP Runtime With Spaces")
  const argvLog = join(root, "post version argv.jsonl")
  const stub = join(import.meta.dir, "omp-version-stub.ts")
  const bun = Bun.which("bun")
  if (bun === null) throw new OmpExecutableStubError("Bun executable is unavailable")
  await mkdir(runtime, { recursive: true })

  if (process.platform === "win32") {
    const executable = join(runtime, "omp.cmd")
    await writeFile(
      executable,
      `@echo off\n"${bun}" "${stub}" "${argvLog}" %*\nexit /b %ERRORLEVEL%\n`,
    )
    return { argvLog, executable }
  }

  const executable = join(runtime, "omp")
  await writeFile(executable, `#!/bin/sh\nexec "${bun}" "${stub}" "${argvLog}" "$@"\n`)
  await chmod(executable, 0o755)
  return { argvLog, executable }
}
