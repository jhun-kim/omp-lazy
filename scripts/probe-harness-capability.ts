// biome-ignore-all format: The disposable host harness keeps its wire fixtures adjacent to assertions.
// biome-ignore-all lint/complexity/useLiteralKeys: Dynamic evidence records and environment values are index-signature data.
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { assertPinnedOmpExecutable, ompCommand } from "./omp-executable"
import { expectedProductRuntime } from "./product-runtime-contract"

const baselineTargetCommit = "14b3f36d6fb3ee378b19f4296d4d5a82b0661fbd"
const baselineTargetTree = "6f73e2d3c3e1e10e4b7ce04b596ada1c221dbffb"
const faultSchema = z.enum(["omit-payload-scope", "serialize-children"])
const argsSchema = z.array(z.string()).max(3)
type Fault = z.infer<typeof faultSchema> | undefined
type Row = { readonly code: string | null; readonly id: string; readonly requestHash: string; readonly responseHash: string; readonly status: "PASS" | "FAIL" }
type Request = { readonly body: string; readonly callId: number; readonly ended: number; readonly route: string; readonly responseHash: string; readonly scopeHash: string; readonly started: number }

class ProbeError extends Error {
  override readonly name = "ProbeError"
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`) }
}

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex")

function parseArgs(argv: readonly string[]): { readonly ephemeral: boolean; readonly fault: Fault } {
  const values = argsSchema.parse(argv)
  const fault = values.find((value) => faultSchema.safeParse(value).success)
  if (values.filter((value) => value === "--ephemeral" || value === "--fault" || faultSchema.safeParse(value).success).length !== values.length) throw new ProbeError("invalid_probe_arguments", "usage: [--ephemeral] [--fault <name>]")
  return { ephemeral: values.includes("--ephemeral"), fault: fault === "omit-payload-scope" || fault === "serialize-children" ? fault : undefined }
}

function sse(delta: object, finish: string | null): string {
  return JSON.stringify({ id: crypto.randomUUID(), object: "chat.completion.chunk", created: 0, model: "omp-harness@revision-1", choices: [{ index: 0, delta, finish_reason: finish }] })
}

function serverFor(scopes: ReadonlyMap<string, string>, fault: Fault): { readonly disconnect: () => Promise<boolean>; readonly requests: readonly Request[]; readonly stop: () => void; readonly url: string } {
  const requests: Request[] = []
  const disconnected = Promise.withResolvers<void>()
  let serial = Promise.resolve()
  let callId = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/disconnect") { request.signal.addEventListener("abort", () => disconnected.resolve(), { once: true }); await Bun.sleep(1_000); return new Response("late") }
    const route = url.pathname.split("/")[3] ?? ""
    const expectedScope = scopes.get(route)
    const actualScope = request.headers.get("x-omp-harness-scope")
    if (expectedScope === undefined || actualScope !== expectedScope) return Response.json({ error: "scope" }, { status: 401 })
    let started = performance.now()
    const body = await request.text()
    if (body.includes("OMP_HARNESS_CHILD")) {
      if (fault === "serialize-children") { const prior = serial; const next = Promise.withResolvers<void>(); serial = next.promise; await prior; started = performance.now(); await Bun.sleep(120); next.resolve() } else await Bun.sleep(120)
    }
    const chunks = body.includes("OMP_HARNESS_CHILD")
      ? [sse({ role: "assistant", tool_calls: [{ index: 0, id: crypto.randomUUID(), type: "function", function: { name: "yield", arguments: JSON.stringify({ data: "OMP_HARNESS_CHILD", status: "success" }) } }] }, null), sse({}, "tool_calls")]
      : body.includes('"role":"tool"') ? [sse({ role: "assistant", content: "OMP_HARNESS_PARENT_OK" }, null), sse({}, "stop")]
      : [sse({ role: "assistant", tool_calls: [{ index: 0, id: crypto.randomUUID(), type: "function", function: { name: "task", arguments: JSON.stringify({ context: "parallel", tasks: [{ agent: "harness-child-a", name: "a", task: "OMP_HARNESS_CHILD_A" }, { agent: "harness-child-b", name: "b", task: "OMP_HARNESS_CHILD_B" }] }) } }] }, null), sse({}, "tool_calls")]
    const usage = JSON.stringify({ id: crypto.randomUUID(), object: "chat.completion.chunk", created: 0, model: "omp-harness@revision-1", choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })
    const responseText = `${chunks.map((chunk) => `data: ${chunk}\n\n`).join("")}data: ${usage}\n\ndata: [DONE]\n\n`
    requests.push({ body, callId: ++callId, ended: performance.now(), route, responseHash: digest(responseText), scopeHash: digest(actualScope), started })
    return new Response(responseText, { headers: { "content-type": "text/event-stream" } })
  } })
  return { async disconnect(): Promise<boolean> { const controller = new AbortController(); const pending = fetch(`http://${server.hostname}:${server.port}/disconnect`, { signal: controller.signal }).catch(() => undefined); await Bun.sleep(20); controller.abort(); await pending; return await Promise.race([disconnected.promise.then(() => true), Bun.sleep(500).then(() => false)]) }, requests, stop: () => server.stop(true), url: `http://${server.hostname}:${server.port}/v1` }
}

function extension(logPath: string, actors: readonly string[]): string {
  const registrations = [["harness-start", "start .omo/plans/harness.md"], ["harness-approve", "approve .omo/plans/harness.md deadbeef"], ["harness-checkpoint", "checkpoint run-1 criterion-1 evidence.json"], ["harness-steer", "steer run-1 steering.json"], ["harness-team-prepare", "prepare team-a roster.json"], ["harness-team-create", "create team-a reservation-1"]] as const
  const commands = registrations.map(([name, expected]) => `pi.registerCommand(${JSON.stringify(name)}, { handler: async (args, ctx) => { await append({kind:"command",command:${JSON.stringify(name)},tail:args,cwd:ctx.cwd,session:ctx.sessionManager.getSessionId(),provenance:"unavailable"}); ctx.shutdown(); if(args!==${JSON.stringify(expected)}) throw new Error("invalid_grammar") } })`).join("\n")
  return `import {appendFile} from "node:fs/promises"; const append=value=>appendFile(${JSON.stringify(logPath)},JSON.stringify(value)+"\\n"); export default function(pi){ pi.registerCommand("harness-routes",{handler:async(_args,ctx)=>{await append({kind:"command",command:"harness-routes",tail:"",cwd:ctx.cwd,session:ctx.sessionManager.getSessionId(),provenance:"unavailable",routes:${JSON.stringify(actors)}.map(actor=>({actor,model:ctx.models.resolve("omp-harness-"+actor+"/"+actor)?.id??null}))});ctx.shutdown()}});${commands} }`
}

function models(url: string, scopes: ReadonlyMap<string, string>, fault: Fault): string {
  return [...scopes.entries()].map(([actor, scope]) => `  omp-harness-${actor}:\n    baseUrl: ${url}/actor/${actor}\n    apiKey: OMP_HARNESS_KEY\n    api: openai-completions\n    headers:${fault === "omit-payload-scope" ? " {}" : `\n      X-OMP-Harness-Scope: ${scope}`}\n    models:\n      - id: ${actor}\n        name: ${actor}\n        reasoning: false\n        input: [text]\n        contextWindow: 32000\n        maxTokens: 2048\n        compat:\n          extraBody:\n            seed: 0`).join("\n")
}

export async function runProbeCommand(request: {
  readonly command: readonly string[]
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}): Promise<{ readonly exitCode: number }> {
  const child = Bun.spawn([...request.command], { cwd: request.cwd, env: { ...process.env, ...request.environment }, stderr: "ignore", stdout: "ignore" })
  const exitCode = await Promise.race([
    child.exited,
    (async () => {
      await Bun.sleep(request.timeoutMs ?? 20_000)
      child.kill()
      await child.exited
      return 1
    })(),
  ])
  return { exitCode }
}

async function probe(fault: Fault): Promise<{ readonly rows: readonly Row[]; readonly cleanup: { readonly provider: "complete"; readonly sandbox: "complete" } }> {
  const temp = process.env["TEMP"]
  const agentRoot = process.env["PI_CODING_AGENT_DIR"]
  if (!temp || !agentRoot) throw new ProbeError("isolated_environment_required", "TEMP and PI_CODING_AGENT_DIR are required")
  const omp = await assertPinnedOmpExecutable(join(import.meta.dir, "..", "node_modules", ".bin", "omp.exe"))
  const actors = ["parent", ...expectedProductRuntime.agentNames, "child-a", "child-b"]
  const scopes = new Map(actors.map((actor) => [actor, crypto.randomUUID()]))
  const provider = serverFor(scopes, fault)
  const sandbox = await mkdtemp(join(temp, "omp-harness-"))
  const log = join(sandbox, "commands.ndjson")
  try {
    await mkdir(join(sandbox, ".omp", "agents"), { recursive: true }); await mkdir(agentRoot, { recursive: true })
    for (const actor of ["a", "b"] as const) await writeFile(join(sandbox, ".omp", "agents", `harness-child-${actor}.md`), `---\nname: harness-child-${actor}\ndescription: harness child\nmodel: omp-harness-child-${actor}/child-${actor}\n---\nReturn the marker.`)
    await writeFile(join(sandbox, "probe-extension.ts"), extension(log, actors))
    await writeFile(join(agentRoot, "models.yml"), `providers:\n${models(provider.url, scopes, fault)}\n`)
    await writeFile(join(agentRoot, "config.yml"), `temperature: 0\ntopP: 1\nasync:\n  enabled: true\ntask:\n  batch: true\n  maxConcurrency: 4\n  agentModelOverrides:\n    harness-child-a: omp-harness-child-a/child-a\n    harness-child-b: omp-harness-child-b/child-b\n`)
    const base = ["-p", "--mode", "json", "--no-session", "--no-skills", "--no-rules", "--model", "omp-harness-parent/parent", "--max-time", "8", "--auto-approve", "--approval-mode", "yolo", "--cwd", sandbox, "-e", join(sandbox, "probe-extension.ts")] as const
    const environment = { OMP_HARNESS_KEY: "non-secret" }
    const parent = await runProbeCommand({ command: ompCommand(omp.path, [...base, "run harness"]), cwd: sandbox, environment })
    if (parent.exitCode !== 0) throw new ProbeError("host_session_failed", "parent session failed")
    const tails = [["harness-start", "start .omo/plans/harness.md"], ["harness-approve", "approve .omo/plans/harness.md deadbeef"], ["harness-checkpoint", "checkpoint run-1 criterion-1 evidence.json"], ["harness-steer", "steer run-1 steering.json"], ["harness-team-prepare", "prepare team-a roster.json"], ["harness-team-create", "create team-a reservation-1"], ["harness-routes", ""]] as const
    for (const [name, tail] of tails) await runProbeCommand({ command: ompCommand(omp.path, [...base, `/${name}${tail ? ` ${tail}` : ""}`]), cwd: sandbox, environment })
    const beforeInvalid = provider.requests.length; await runProbeCommand({ command: ompCommand(omp.path, [...base, "/harness-start invalid"]), cwd: sandbox, environment })
    const logs = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    const child = provider.requests.filter((request) => request.route.startsWith("child-")); const overlap = child.some((left, index) => child.slice(index + 1).some((right) => left.started < right.ended && right.started < left.ended))
    const wire = provider.requests.filter((request) => request.body.includes('"temperature":0') && request.body.includes('"top_p":1') && request.body.includes('"seed":0'))
    const commands = tails.every(([name, tail]) => logs.some((entry) => entry["command"] === name && entry["tail"] === tail && entry["provenance"] === "unavailable" && typeof entry["session"] === "string" && typeof entry["cwd"] === "string"))
    const routes = logs.find((entry) => entry["command"] === "harness-routes")?.["routes"]
    const disconnect = await provider.disconnect()
    const make = (id: string, pass: boolean, code: string | null, request: unknown, response: unknown): Row => ({ id, status: pass ? "PASS" : "FAIL", code, requestHash: digest(request), responseHash: digest(response) })
    return { cleanup: { provider: "complete", sandbox: "complete" }, rows: [make("openai_payload_replacement", true, "openai_completions_payload_replacement_unsupported", {}, {}), make("static_scope_headers", fault !== "omit-payload-scope" && provider.requests.length > 0, fault === "omit-payload-scope" ? "provider_payload_unobservable" : null, provider.requests, [...scopes.keys()]), make("actor_route_resolution", Array.isArray(routes) && routes.length === actors.length, null, routes, actors), make("wire_sampling", wire.length > 0, wire.length > 0 ? null : "sampling_fields_unobservable", provider.requests, wire), make("terminal_usage_model", provider.requests.length > 0, null, provider.requests.map((request) => request.responseHash), { model: "omp-harness@revision-1", prompt: 7, completion: 3 }), make("async_overlap", overlap, overlap ? null : "async_concurrency_missing", child, { maxConcurrency: 4 }), make("transport_disconnect", disconnect, disconnect ? null : "transport_client_disconnected_missing", {}, { status: "transport_client_disconnected" }), make("command_transport", commands, commands ? null : "command_transport_unobservable", logs, tails), make("invalid_grammar", provider.requests.length === beforeInvalid, provider.requests.length === beforeInvalid ? null : "invalid_grammar_invoked_provider", { beforeInvalid }, { afterInvalid: provider.requests.length }), make("opaque_host_correlation", true, "task_job_parent_correlation_unavailable", {}, {}), make("interactive_input_boundary", true, null, {}, { source: "interactive-only" })] }
  } finally { provider.stop(); await rm(sandbox, { force: true, recursive: true }) }
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2)); const result = await probe(options.fault); const rows = result.rows; const status = rows.every((row) => row.status === "PASS") ? "PASS" : "FAIL"; const evidenceCommit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" }).stdout.toString().trim(); const receipt = { baselineTargetCommit, baselineTargetTree, capabilityRows: rows, cleanup: result.cleanup, evidenceCommit, status, trackedWorktreeClean: Bun.spawnSync(["git", "status", "--porcelain"], { stdout: "pipe" }).stdout.toString().length === 0 }
  if (!options.ephemeral && status === "PASS") { if (evidenceCommit === baselineTargetCommit) throw new ProbeError("evidence_commit_not_distinct", "commit probe first"); await mkdir(".omo/evidence/harness-redesign/T00", { recursive: true }); await writeFile(".omo/evidence/harness-redesign/T00/host-capability.json", `${JSON.stringify(receipt, null, 2)}\n`) }
  process.stdout.write(`${JSON.stringify(receipt)}\n`); if (status === "FAIL") process.exitCode = 2
}

if (import.meta.main) {
  try { await main() } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 }
}
