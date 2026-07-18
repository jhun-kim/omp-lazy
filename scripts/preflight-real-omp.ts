import { lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { z } from "zod"
import { startLoopbackProvider } from "../test/fixtures/omp-provider-server"
import { assertPinnedOmpExecutable, ompCommand, parseOmpExecutableOption } from "./omp-executable"

const fakeKey = "omp-lazy-non-secret-preflight-key"

type PreflightReceipt = {
  readonly async: { readonly agentId: string; readonly jobId: string }
  readonly cleanup: { readonly provider: "complete"; readonly sandbox: "complete" }
  readonly omp: { readonly path: string; readonly sha256: string; readonly version: string }
  readonly provider: { readonly requestCount: number; readonly url: string }
  readonly roots: { readonly agent: string; readonly sandbox: string }
  readonly session: { readonly exitCode: number; readonly marker: string }
  readonly status: "DIAGNOSTIC_ONLY" | "PASS"
  readonly symlink:
    | { readonly capable: true; readonly target: string }
    | { readonly capable: "NOT_RUN"; readonly target: null }
}

class PreflightError extends Error {
  override readonly name = "PreflightError"
}

function parseArguments(argv: readonly string[]): {
  readonly diagnosticProviderOnly: boolean
  readonly ompPath: string
} {
  const parsed = parseOmpExecutableOption(argv)
  const rest = z
    .union([z.tuple([]), z.tuple([z.literal("--diagnostic-provider-only")])])
    .parse(parsed.rest)
  return { diagnosticProviderOnly: rest.length === 1, ompPath: resolve(parsed.ompPath) }
}

function findIdentity(output: string, key: "agentId" | "jobId", fallback: string): string {
  const pattern = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`)
  return pattern.exec(output)?.[1] ?? (output.includes(fallback) ? fallback : "")
}

async function main(): Promise<void> {
  const { diagnosticProviderOnly, ompPath } = parseArguments(Bun.argv.slice(2))
  const omp = await assertPinnedOmpExecutable(ompPath)

  const { TEMP: tempRoot, PI_CODING_AGENT_DIR: agentRoot } = process.env
  if (tempRoot === undefined || agentRoot === undefined) {
    throw new PreflightError("isolated TEMP and PI_CODING_AGENT_DIR are required")
  }
  const sandbox = await mkdtemp(join(tempRoot, "omp-lazy-preflight-"))
  const provider = startLoopbackProvider()

  try {
    await mkdir(agentRoot, { recursive: true })
    await writeFile(
      join(agentRoot, "models.yml"),
      [
        "providers:",
        "  omp-lazy-local:",
        `    baseUrl: ${provider.url}`,
        "    apiKey: OMP_LAZY_PROVIDER_KEY",
        "    api: openai-completions",
        "    models:",
        "      - id: omp-lazy-preflight",
        "        name: OMP Lazy Preflight",
        "        reasoning: false",
        "        input: [text]",
        "        contextWindow: 32000",
        "        maxTokens: 2048",
        "",
      ].join("\n"),
    )
    await writeFile(
      join(agentRoot, "config.yml"),
      "async:\n  enabled: true\ntask:\n  batch: false\n",
    )

    let linkTarget: string | undefined
    if (!diagnosticProviderOnly) {
      const source = join(sandbox, "symlink-source")
      const link = join(sandbox, "symlink-link")
      await mkdir(source)
      await symlink(source, link)
      const linkStat = await lstat(link)
      linkTarget = await realpath(resolve(dirname(link), await readlink(link)))
      if (!linkStat.isSymbolicLink() || linkTarget !== (await realpath(source))) {
        throw new PreflightError("Windows symlink capability did not preserve the exact target")
      }
    }

    const session = Bun.spawn(
      [
        ...ompCommand(omp.path, [
          "-p",
          "--mode",
          "json",
          "--no-session",
          "--no-extensions",
          "--no-skills",
          "--no-rules",
          "--model",
          "omp-lazy-local/omp-lazy-preflight",
          "--max-time",
          "90",
          "--auto-approve",
          "--approval-mode",
          "yolo",
          "--cwd",
          sandbox,
          "Launch exactly one task agent named preflight-worker and wait for its result.",
        ]),
      ],
      {
        env: { ...process.env, OMP_LAZY_PROVIDER_KEY: fakeKey },
        stderr: "pipe",
        stdout: "pipe",
      },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      session.exited,
      new Response(session.stdout).text(),
      new Response(session.stderr).text(),
    ])
    const output = `${stdout}\n${stderr}`
    const agentId = findIdentity(output, "agentId", "preflight-worker")
    const jobId = findIdentity(output, "jobId", "preflight-worker")
    if (exitCode !== 0 || agentId.length === 0 || jobId.length === 0) {
      throw new PreflightError(
        `async task/job session failed (${exitCode}): ${output.slice(-2000)}`,
      )
    }

    const receipt: PreflightReceipt = {
      async: { agentId, jobId },
      cleanup: { provider: "complete", sandbox: "complete" },
      omp,
      provider: { requestCount: provider.requests.length, url: provider.url },
      roots: { agent: await realpath(agentRoot), sandbox: await realpath(sandbox) },
      session: {
        exitCode,
        marker: output.includes("OMP_LAZY_WORKER_OK") ? "observed" : "delivered",
      },
      status: diagnosticProviderOnly ? "DIAGNOSTIC_ONLY" : "PASS",
      symlink: diagnosticProviderOnly
        ? { capable: "NOT_RUN", target: null }
        : { capable: true, target: z.string().parse(linkTarget) },
    }
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
  } finally {
    provider.stop()
    await rm(sandbox, { force: true, recursive: true })
  }
}

// no-excuse-ok: catch — preflight is a process boundary and must fail closed.
try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}
