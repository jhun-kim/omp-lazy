type ProviderRequest = {
  readonly body: string
  readonly method: string
  readonly pathname: string
}

export type LoopbackProvider = {
  readonly requests: readonly ProviderRequest[]
  readonly url: string
  readonly stop: () => void
}

const WORKER_MARKER = "OMP_LAZY_WORKER_OK"

function completionChunk(delta: object, finishReason: string | null): string {
  return JSON.stringify({
    id: crypto.randomUUID(),
    object: "chat.completion.chunk",
    created: 0,
    model: "omp-lazy-preflight",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })
}

function sse(chunks: readonly string[]): Response {
  const body = `${chunks.map((chunk) => `data: ${chunk}\n\n`).join("")}data: [DONE]\n\n`
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
    status: 200,
  })
}

function lastUserText(body: string): string {
  const parsed: unknown = JSON.parse(body)
  if (typeof parsed !== "object" || parsed === null || !("messages" in parsed)) return ""
  const messages = parsed.messages
  if (!Array.isArray(messages)) return ""
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (typeof message !== "object" || message === null) continue
    if (!("role" in message) || message.role !== "user" || !("content" in message)) continue
    if (typeof message.content === "string") return message.content
  }
  return ""
}

function responseFor(body: string): Response {
  if (lastUserText(body).includes(WORKER_MARKER)) {
    return sse([
      completionChunk({ role: "assistant", content: WORKER_MARKER }, null),
      completionChunk({}, "stop"),
    ])
  }

  const parsed: unknown = JSON.parse(body)
  const serialized = JSON.stringify(parsed)
  if (serialized.includes("Spawned agent") || serialized.includes('"role":"tool"')) {
    return sse([
      completionChunk({ role: "assistant", content: "OMP_LAZY_MAIN_OK" }, null),
      completionChunk({}, "stop"),
    ])
  }

  const arguments_ = JSON.stringify({
    agent: "task",
    name: "preflight-worker",
    task: `Return exact marker ${WORKER_MARKER}.`,
  })
  return sse([
    completionChunk(
      {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_omp_lazy_preflight",
            type: "function",
            function: { name: "task", arguments: arguments_ },
          },
        ],
      },
      null,
    ),
    completionChunk({}, "tool_calls"),
  ])
}

export function startLoopbackProvider(): LoopbackProvider {
  const requests: ProviderRequest[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = await request.text()
      requests.push({ body, method: request.method, pathname: url.pathname })
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        return Response.json({ error: "not found" }, { status: 404 })
      }
      return responseFor(body)
    },
  })
  return {
    requests,
    url: `http://${server.hostname}:${server.port}/v1`,
    stop: () => server.stop(true),
  }
}
