import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader"
import { z } from "zod"
import { removeTestTree } from "./remove-test-tree"

const roots: string[] = []
const commandResultSchema = z.strictObject({
  schemaVersion: z.literal(2),
  status: z.enum(["PASS", "BLOCKED"]),
  workflow: z.string(),
  operation: z.string(),
  runId: z.string().nullable(),
  revision: z.number().int().nonnegative().nullable(),
  runStatus: z.string().nullable(),
  code: z.string().nullable(),
})

export type CommandResult = z.infer<typeof commandResultSchema>

function git(root: string, args: readonly string[]): void {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stderr: "pipe", stdout: "pipe" })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
}

export async function cleanupWorkflowRoots(): Promise<void> {
  await Promise.all(roots.splice(0).map(removeTestTree))
}

export async function workflowRepository(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `omp-lazy-t06-${label}-`))
  roots.push(root)
  git(root, ["init", "--quiet"])
  git(root, ["config", "user.email", "fixture@example.invalid"])
  git(root, ["config", "user.name", "Fixture"])
  await writeFile(join(root, ".gitignore"), ".omo/\n")
  await writeFile(join(root, "tracked.txt"), "fixture\n")
  git(root, ["add", ".gitignore", "tracked.txt"])
  git(root, ["commit", "--quiet", "-m", "fixture"])
  return root
}

export async function publicWorkflowRuntime(root: string) {
  const loaded = await loadExtensions([join(process.cwd(), "src", "index.ts")], process.cwd())
  const extension = loaded.extensions[0]
  if (extension === undefined) throw new Error("product extension missing")
  const results: CommandResult[] = []
  const prompts: string[] = []
  loaded.runtime.sendMessage = (message) => {
    const parsed = z
      .object({ customType: z.literal("omp-lazy-command-result"), details: commandResultSchema })
      .passthrough()
      .safeParse(message)
    if (parsed.success) results.push(parsed.data.details)
  }
  loaded.runtime.sendUserMessage = (content) => {
    if (typeof content === "string") prompts.push(content)
  }
  return {
    extension,
    loaded,
    results,
    prompts,
    invoke: async (name: string, args: string, sessionId = "parent-session") => {
      const command = extension.commands.get(name)
      if (command === undefined) throw new Error(`${name} command missing`)
      await command.handler(args, {
        cwd: root,
        sessionManager: { getSessionId: () => sessionId },
      } as Parameters<typeof command.handler>[1])
    },
  }
}

export const workflowPlan = `# Fixture plan

<!-- omp-lazy-ulw-plan:plan:v2 -->

## TL;DR (For humans)
Fixture.
## Scope
Contained.
## Verification strategy
Deterministic.
## Execution strategy
Serial.
## Todos
- [ ] **T1. Complete fixture**
## Final verification wave
## Commit strategy
One commit.
## Success criteria
Complete.
`
