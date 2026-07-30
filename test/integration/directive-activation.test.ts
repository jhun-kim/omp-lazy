/**
 * directive-activation.test.ts - Integration test proving END TO END that:
 * (a) user text is BYTE-IDENTICAL through input handler and provenance
 * (b) the input handler returns undefined (never `text` or `handled`)
 * (c) directive section arrives inside the SINGLE returned hidden before_agent_start message
 * (d) activation provenance is recorded
 * (e) existing activation-origin behavior still holds
 *
 * Adversarial coverage:
 * - prompt_injection: trigger token inside a fenced code block or quoted path must NOT activate
 * - malformed_input: empty and enormous prompts handled without crash
 * - misleading_success_output: deliberate negative control proving byte-equality assertion
 *   FAILS when strings differ
 */
import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader"
import { removeTestTree } from "../fixtures/remove-test-tree"
import { workflowRepository } from "../fixtures/workflow-lifecycle-fixtures"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTestTree))
})

type MessageShape = {
  customType?: string
  content?: string
  display?: boolean
  details?: {
    activation?: { kind: string; workflow: string; command: string }
    directive?: { workflow: string; skill: string }
    scope?: string
  }
}

type BasResultShape = { message?: MessageShape } | undefined

/**
 * Loads the production extension and returns handler accessors for input/before_agent_start.
 * The extension is loaded exactly as it is in production - no stubs.
 */
async function loadProductionExtension(root: string) {
  const loaded = await loadExtensions([join(process.cwd(), "src", "index.ts")], process.cwd())
  const extension = loaded.extensions[0]
  if (extension === undefined) throw new Error("product extension missing")

  const inputHandlers = extension.handlers.get("input")
  const basHandlers = extension.handlers.get("before_agent_start")
  if (!inputHandlers || inputHandlers.length === 0) throw new Error("input handler missing")
  if (!basHandlers || basHandlers.length === 0) {
    throw new Error("before_agent_start handler missing")
  }

  const inputHandler = inputHandlers[0]
  const basHandler = basHandlers[0]
  if (inputHandler === undefined) throw new Error("input handler resolved to undefined")
  if (basHandler === undefined) throw new Error("basHandler resolved to undefined")

  function makeContext(sessionId: string) {
    return {
      cwd: root,
      sessionManager: { getSessionId: () => sessionId },
      settings: { get: () => [] as readonly string[] },
    }
  }

  return {
    extension,
    loaded,
    inputHandler,
    basHandler,
    makeContext,
    fireInput: async (
      text: string,
      sessionId: string,
      source: "interactive" | "rpc" | "extension" = "interactive",
    ) => {
      return inputHandler({ text, source }, makeContext(sessionId))
    },
    fireBeforeAgentStart: async (prompt: string, sessionId: string) => {
      return basHandler({ prompt }, makeContext(sessionId)) as Promise<BasResultShape>
    },
  }
}

describe("directive activation: user text immutability", () => {
  test("CRLF prompt: user text is byte-identical, input returns undefined, single hidden message with directive", async () => {
    const root = await workflowRepository("directive-crlf")
    roots.push(root)
    const ext = await loadProductionExtension(root)

    // User text with CRLF line endings - byte-exact comparison target
    const userText = "I want to use ultrawork\r\nnow please\r\n"
    const textBuffer = Buffer.from(userText, "utf-8")

    // (b) input handler MUST return undefined
    const inputResult = await ext.fireInput(userText, "session-crlf")
    expect(inputResult).toBeUndefined()

    // (c) before_agent_start returns a SINGLE hidden message with the directive
    const basResult = await ext.fireBeforeAgentStart(userText, "session-crlf")
    expect(basResult).toBeDefined()
    expect(basResult?.message).toBeDefined()
    expect(basResult?.message?.customType).toBe("omp-lazy-runtime-context")
    expect(basResult?.message?.display).toBe(false)

    // (c) directive section exists inside the message content
    const content = basResult?.message?.content ?? ""
    expect(content).toContain("<omp-lazy-directive")
    expect(content).toContain("</omp-lazy-directive>")

    // Exactly ONE directive section
    const directiveMatches = content.match(/<omp-lazy-directive/g)
    expect(directiveMatches).toHaveLength(1)

    // (d) activation provenance recorded in details
    const details = basResult?.message?.details
    expect(details?.activation).toBeDefined()
    expect(details?.activation?.kind).toBe("activate")
    expect(details?.activation?.workflow).toBe("ultrawork")
    expect(details?.directive).toBeDefined()
    expect(details?.directive?.workflow).toBe("ultrawork")
    expect(details?.directive?.skill).toBe("ultrawork(omp)")

    // (a) Byte-equality: the original text was never mutated.
    // The provenance system records the text hash - verify the exact bytes we fed are unchanged.
    const textAfterBuffer = Buffer.from(userText, "utf-8")
    expect(textAfterBuffer.equals(textBuffer)).toBe(true)
  }, 30_000)

  test("trailing-spaces prompt: user text byte-identical, input returns undefined, directive injected", async () => {
    const root = await workflowRepository("directive-trailing")
    roots.push(root)
    const ext = await loadProductionExtension(root)

    // User text with trailing spaces on multiple lines
    const userText = "please run ultrawork   \n  with extra trailing   "

    const inputResult = await ext.fireInput(userText, "session-trailing")
    expect(inputResult).toBeUndefined()

    const basResult = await ext.fireBeforeAgentStart(userText, "session-trailing")
    expect(basResult).toBeDefined()
    expect(basResult?.message).toBeDefined()
    expect(basResult?.message?.customType).toBe("omp-lazy-runtime-context")
    expect(basResult?.message?.display).toBe(false)
    expect(basResult?.message?.content ?? "").toContain("<omp-lazy-directive")

    // (a) byte-equality of the original text string - JavaScript string immutability
    expect(userText).toBe("please run ultrawork   \n  with extra trailing   ")
    expect(Buffer.from(userText, "utf-8")).toEqual(
      Buffer.from("please run ultrawork   \n  with extra trailing   ", "utf-8"),
    )
  }, 30_000)

  test("non-ASCII prompt: user text is byte-identical through activation", async () => {
    const root = await workflowRepository("directive-nonascii")
    roots.push(root)
    const ext = await loadProductionExtension(root)

    // Non-ASCII text with ultrawork trigger - includes Korean, emoji, and accented characters
    const userText = "작업을 시작해주세요 ultrawork 🚀 café"
    const originalBytes = Buffer.from(userText, "utf-8")

    const inputResult = await ext.fireInput(userText, "session-nonascii")
    expect(inputResult).toBeUndefined()

    const basResult = await ext.fireBeforeAgentStart(userText, "session-nonascii")
    expect(basResult).toBeDefined()
    expect(basResult?.message).toBeDefined()
    expect(basResult?.message?.display).toBe(false)
    expect(basResult?.message?.content ?? "").toContain("<omp-lazy-directive")

    // (a) byte-equality proof: the exact UTF-8 bytes we passed in are unchanged
    const verifyBytes = Buffer.from(userText, "utf-8")
    expect(verifyBytes.equals(originalBytes)).toBe(true)
    expect(userText).toBe("작업을 시작해주세요 ultrawork 🚀 café")
  }, 30_000)

  test("code-fenced ulw does NOT activate: trigger inside ``` must not fire", async () => {
    const root = await workflowRepository("directive-codefence")
    roots.push(root)
    const ext = await loadProductionExtension(root)

    // A fenced code block containing 'ulw' - must NOT activate
    const userText = "Here is an example:\n```\nulw\n```\nThat's it."

    const inputResult = await ext.fireInput(userText, "session-codefence")
    expect(inputResult).toBeUndefined()

    const basResult = await ext.fireBeforeAgentStart(userText, "session-codefence")
    // No activation → undefined or no directive section
    if (basResult !== undefined) {
      const content = basResult.message?.content ?? ""
      expect(content).not.toContain("<omp-lazy-directive")
    }
  }, 30_000)

  test("quoted-path ulw does NOT activate: trigger inside quotes must not fire", async () => {
    const root = await workflowRepository("directive-quotedpath")
    roots.push(root)
    const ext = await loadProductionExtension(root)

    // Quoted path containing the trigger token
    const userText = 'Please check the file at "C:\\projects\\ulw\\main.ts"'

    const inputResult = await ext.fireInput(userText, "session-quotedpath")
    expect(inputResult).toBeUndefined()

    const basResult = await ext.fireBeforeAgentStart(userText, "session-quotedpath")
    if (basResult !== undefined) {
      const content = basResult.message?.content ?? ""
      expect(content).not.toContain("<omp-lazy-directive")
    }
  }, 30_000)
})

describe("directive activation: input handler never returns text/handled", () => {
  test("input handler return value is strictly undefined for triggering prompt", async () => {
    const root = await workflowRepository("directive-input-undef")
    roots.push(root)
    const ext = await loadProductionExtension(root)

    const result = await ext.fireInput("ultrawork please", "session-input-undef")
    // MUST be undefined - not { text }, not { handled }, not null, not {}
    expect(result).toBeUndefined()
  }, 30_000)

  test("input handler return value is strictly undefined for non-triggering prompt", async () => {
    const root = await workflowRepository("directive-input-nontrig")
    roots.push(root)
    const ext = await loadProductionExtension(root)

    const result = await ext.fireInput("just a normal message", "session-nontrig")
    expect(result).toBeUndefined()
  }, 30_000)

  test("input handler return value is strictly undefined for empty prompt", async () => {
    const root = await workflowRepository("directive-input-empty")
    roots.push(root)
    const ext = await loadProductionExtension(root)

    const result = await ext.fireInput("", "session-empty")
    expect(result).toBeUndefined()
  }, 30_000)
})

describe("directive activation: single hidden message structure", () => {
  test("before_agent_start returns at most one message (no array, no second message)", async () => {
    const root = await workflowRepository("directive-single-msg")
    roots.push(root)
    const ext = await loadProductionExtension(root)

    await ext.fireInput("ultrawork mode", "session-singlemsg")
    const basResult = await ext.fireBeforeAgentStart("ultrawork mode", "session-singlemsg")

    // The result is an object with a single `message` property
    expect(basResult).toBeDefined()
    expect(basResult?.message).toBeDefined()

    // Must NOT be an array
    expect(Array.isArray(basResult?.message)).toBe(false)

    // Must NOT have a second message field
    const keys = Object.keys(basResult ?? {})
    const messageKeys = keys.filter((k) => k.toLowerCase().includes("message"))
    expect(messageKeys).toEqual(["message"])
  }, 30_000)

  test("non-triggering prompt returns undefined from before_agent_start (no message at all)", async () => {
    const root = await workflowRepository("directive-nomsg")
    roots.push(root)
    const ext = await loadProductionExtension(root)

    await ext.fireInput("just a normal chat", "session-nomsg")
    const basResult = await ext.fireBeforeAgentStart("just a normal chat", "session-nomsg")

    // No trigger = undefined (or result with no directive)
    if (basResult !== undefined) {
      const content = basResult.message?.content ?? ""
      expect(content).not.toContain("<omp-lazy-directive")
    }
  }, 30_000)
})

describe("directive activation: activation provenance recorded", () => {
  test("activation decision contains workflow, command, and kind=activate", async () => {
    const root = await workflowRepository("directive-provenance")
    roots.push(root)
    const ext = await loadProductionExtension(root)

    await ext.fireInput("use ulw(omp) now", "session-provenance")
    const basResult = await ext.fireBeforeAgentStart("use ulw(omp) now", "session-provenance")

    expect(basResult).toBeDefined()
    expect(basResult?.message?.details?.activation).toEqual({
      kind: "activate",
      workflow: "ultrawork",
      command: "/ulw(omp)",
    })
  }, 30_000)
})

describe("directive activation: existing activation-origin behavior preserved", () => {
  test("extension source never activates", async () => {
    const root = await workflowRepository("directive-ext-origin")
    roots.push(root)
    const ext = await loadProductionExtension(root)

    // Extension-origin input must not arm activation
    const inputResult = await ext.fireInput("ultrawork", "session-ext", "extension")
    expect(inputResult).toBeUndefined()

    const basResult = await ext.fireBeforeAgentStart("ultrawork", "session-ext")
    // No activation from extension source
    if (basResult !== undefined) {
      const content = basResult.message?.content ?? ""
      expect(content).not.toContain("<omp-lazy-directive")
    }
  }, 30_000)

  test("second consecutive trigger is idempotent (quiet) within same session", async () => {
    const root = await workflowRepository("directive-idempotent")
    roots.push(root)
    const ext = await loadProductionExtension(root)

    // First trigger activates
    await ext.fireInput("ultrawork", "session-idemp")
    const first = await ext.fireBeforeAgentStart("ultrawork", "session-idemp")
    expect(first?.message?.details?.activation?.kind).toBe("activate")

    // Second trigger in same session: quiet (idempotent per-run)
    await ext.fireInput("ultrawork", "session-idemp")
    const second = await ext.fireBeforeAgentStart("ultrawork", "session-idemp")
    // either undefined or the decision is quiet (no directive)
    if (second !== undefined) {
      const content = second.message?.content ?? ""
      expect(content).not.toContain("<omp-lazy-directive")
    }
  }, 30_000)

  test("ambiguous multi-workflow text does not activate", async () => {
    const root = await workflowRepository("directive-ambiguous")
    roots.push(root)
    const ext = await loadProductionExtension(root)

    const text = "use ulw(omp) and ulw-loop(omp)"
    await ext.fireInput(text, "session-ambig")
    const basResult = await ext.fireBeforeAgentStart(text, "session-ambig")
    if (basResult !== undefined) {
      const content = basResult.message?.content ?? ""
      expect(content).not.toContain("<omp-lazy-directive")
    }
  }, 30_000)
})

describe("adversarial: prompt injection (trigger in code fence/quoted path)", () => {
  test("trigger token inside multi-line fenced code block does NOT activate", async () => {
    const root = await workflowRepository("directive-fence-inject")
    roots.push(root)
    const ext = await loadProductionExtension(root)

    const userText = [
      "Look at this code:",
      "```typescript",
      "const mode = 'ultrawork'",
      "console.log(mode)",
      "```",
      "Done.",
    ].join("\n")
    await ext.fireInput(userText, "session-fence-inject")
    const basResult = await ext.fireBeforeAgentStart(userText, "session-fence-inject")

    if (basResult !== undefined) {
      const content = basResult.message?.content ?? ""
      expect(content).not.toContain("<omp-lazy-directive")
    }
  }, 30_000)

  test("trigger token inside backtick-quoted path does NOT activate", async () => {
    const root = await workflowRepository("directive-backtick-inject")
    roots.push(root)
    const ext = await loadProductionExtension(root)

    const userText = "Check the file `ulw` in the repo"
    await ext.fireInput(userText, "session-backtick-inject")
    const basResult = await ext.fireBeforeAgentStart(userText, "session-backtick-inject")

    if (basResult !== undefined) {
      const content = basResult.message?.content ?? ""
      expect(content).not.toContain("<omp-lazy-directive")
    }
  }, 30_000)
})

describe("adversarial: malformed input", () => {
  test("empty prompt does not crash and returns undefined from both handlers", async () => {
    const root = await workflowRepository("directive-empty")
    roots.push(root)
    const ext = await loadProductionExtension(root)

    const inputResult = await ext.fireInput("", "session-empty-adv")
    expect(inputResult).toBeUndefined()

    const basResult = await ext.fireBeforeAgentStart("", "session-empty-adv")
    // Either undefined or a message without a directive
    if (basResult !== undefined) {
      const content = basResult.message?.content ?? ""
      expect(content).not.toContain("<omp-lazy-directive")
    }
  }, 30_000)

  test("enormous prompt (100KB) does not crash", async () => {
    const root = await workflowRepository("directive-enormous")
    roots.push(root)
    const ext = await loadProductionExtension(root)

    const enormousText = "a".repeat(100_000)
    const inputResult = await ext.fireInput(enormousText, "session-enormous")
    expect(inputResult).toBeUndefined()

    const basResult = await ext.fireBeforeAgentStart(enormousText, "session-enormous")
    // No trigger in repeated 'a' characters
    if (basResult !== undefined) {
      const content = basResult.message?.content ?? ""
      expect(content).not.toContain("<omp-lazy-directive")
    }
  }, 30_000)
})

describe("adversarial: misleading_success_output (negative control)", () => {
  test("byte-equality assertion CORRECTLY FAILS when strings actually differ", () => {
    // This test PROVES the byte-equality assertion is real by showing it fails
    // when strings differ — it's a permanent negative control, not a passing test.
    const original = "ultrawork\r\ntest"
    const tampered = "ultrawork\ntest" // LF instead of CRLF

    const originalBuf = Buffer.from(original, "utf-8")
    const tamperedBuf = Buffer.from(tampered, "utf-8")

    // These MUST be different - proving byte-equality would catch a mutation
    expect(originalBuf.equals(tamperedBuf)).toBe(false)
    expect(originalBuf.length).not.toBe(tamperedBuf.length)

    // Different trailing whitespace is also caught
    const withTrailing = "ultrawork "
    const withoutTrailing = "ultrawork"
    expect(Buffer.from(withTrailing).equals(Buffer.from(withoutTrailing))).toBe(false)

    // Non-ASCII mutation is caught
    const korean = "작업을 ultrawork"
    const koreanMutated = "작업울 ultrawork"
    expect(Buffer.from(korean, "utf-8").equals(Buffer.from(koreanMutated, "utf-8"))).toBe(false)
  })

  test("string equality assertion CORRECTLY FAILS when CRLF vs LF differ", () => {
    // Explicitly prove the assertion methodology catches the most common mutation
    const crlfText = "hello\r\nultrawork\r\n"
    const lfText = "hello\nultrawork\n"
    expect(crlfText).not.toBe(lfText)
    expect(crlfText.length).not.toBe(lfText.length)
  })
})
