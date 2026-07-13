#!/usr/bin/env node

import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const DRAFT_MARKER = "<!-- omp-lazy-ulw-plan:draft:v1 -->"
const PLAN_MARKER = "<!-- omp-lazy-ulw-plan:plan:v1 -->"
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/

export const PLAN_SECTION_HEADERS = [
  "## TL;DR (For humans)",
  "## Scope",
  "## Verification strategy",
  "## Execution strategy",
  "## Todos",
  "## Final verification wave",
  "## Commit strategy",
  "## Success criteria",
]

function missing(error) {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT"
}

async function statOrNull(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
}

function assertContained(parent, child, message) {
  const childRelative = relative(parent, child)
  if (childRelative.startsWith("..") || isAbsolute(childRelative)) throw new Error(message)
}

export function parseArgs(argv) {
  let slug
  let intent = "unspecified"
  let mode = "draft"
  let modeWasSet = false
  let reset = false
  let force = false

  for (const argument of argv.slice(2)) {
    if (argument === "--clear" || argument === "--unclear") {
      const nextIntent = argument.slice(2)
      if (intent !== "unspecified" && intent !== nextIntent) {
        throw new Error("choose exactly one intent: --clear or --unclear")
      }
      intent = nextIntent
    } else if (argument === "--draft" || argument === "--plan") {
      const nextMode = argument.slice(2)
      if (modeWasSet && mode !== nextMode)
        throw new Error("choose exactly one mode: --draft or --plan")
      mode = nextMode
      modeWasSet = true
    } else if (argument === "--reset") {
      reset = true
    } else if (argument === "--force") {
      force = true
    } else if (argument.startsWith("--")) {
      throw new Error(`unknown flag: ${argument}`)
    } else if (slug === undefined) {
      slug = argument
    } else {
      throw new Error(`unexpected argument: ${argument}`)
    }
  }

  if (slug === undefined) {
    throw new Error(
      "usage: scaffold-plan.mjs <slug> [--clear|--unclear] [--draft|--plan] [--reset [--force]]",
    )
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(`invalid slug "${slug}" - use lowercase letters, digits, and hyphens only`)
  }
  if (force && !reset) throw new Error("--force requires --reset")
  if (mode === "plan" && intent !== "unspecified") {
    throw new Error("--plan reads intent from the approved draft; omit --clear and --unclear")
  }
  return { force, intent, mode, reset, slug }
}

async function inspectDirectory(workspace, path) {
  const stat = await statOrNull(path)
  if (stat === null) return
  if (stat.isSymbolicLink()) throw new Error(`refused: path component is a symlink: ${path}`)
  if (!stat.isDirectory()) throw new Error(`refused: path component is not a directory: ${path}`)
  const resolved = await realpath(path)
  assertContained(workspace, resolved, `refused: directory escapes workspace: ${path}`)
}

async function inspectTarget(path, marker) {
  const stat = await statOrNull(path)
  if (stat === null) return { kind: "missing", content: null }
  if (stat.isSymbolicLink()) throw new Error(`refused: target is a symlink: ${path}`)
  if (!stat.isFile()) throw new Error(`refused: target is not a regular file: ${path}`)
  const content = await readFile(path, "utf8")
  if (!content.includes(marker)) return { kind: "human", content }
  return { kind: "artifact", content }
}

async function inspectWorkspace(cwd, slug) {
  const workspace = await realpath(resolve(cwd))
  const omo = join(workspace, ".omo")
  const drafts = join(omo, "drafts")
  const plans = join(omo, "plans")
  await inspectDirectory(workspace, omo)
  await inspectDirectory(workspace, drafts)
  await inspectDirectory(workspace, plans)
  const draftPath = join(drafts, `${slug}.md`)
  const planPath = join(plans, `${slug}.md`)
  assertContained(omo, draftPath, "refused: draft path escapes .omo")
  assertContained(omo, planPath, "refused: plan path escapes .omo")
  const [draft, plan] = await Promise.all([
    inspectTarget(draftPath, DRAFT_MARKER),
    inspectTarget(planPath, PLAN_MARKER),
  ])
  if (draft.kind === "human") throw new Error(`refused: non-artifact collision: ${draftPath}`)
  if (plan.kind === "human") throw new Error(`refused: non-artifact collision: ${planPath}`)
  return { draft, draftPath, drafts, omo, plan, planPath, plans, workspace }
}

async function ensureDirectory(path, stopAt) {
  if (path === stopAt) return
  const parent = dirname(path)
  assertContained(stopAt, path, `refused: directory escapes workspace: ${path}`)
  await ensureDirectory(parent, stopAt)
  const stat = await statOrNull(path)
  if (stat !== null) {
    if (stat.isSymbolicLink()) throw new Error(`refused: path component is a symlink: ${path}`)
    if (!stat.isDirectory()) throw new Error(`refused: path component is not a directory: ${path}`)
    return
  }
  await mkdir(path)
}

async function prepareDirectories(paths) {
  await ensureDirectory(paths.omo, paths.workspace)
  await ensureDirectory(paths.drafts, paths.workspace)
  await ensureDirectory(paths.plans, paths.workspace)
  await inspectDirectory(paths.workspace, paths.omo)
  await inspectDirectory(paths.workspace, paths.drafts)
  await inspectDirectory(paths.workspace, paths.plans)
}

function hasApproval(content) {
  return /^status: approved$/m.test(content) && /^approval: explicit-user-approval$/m.test(content)
}

export function buildDraft(slug, intent) {
  return `---
slug: ${slug}
status: drafting
intent: ${intent}
review-required: false
pending-action: write .omo/plans/${slug}.md
approval: pending
---

${DRAFT_MARKER}

# Draft: ${slug}

## Components
<!-- id | independently testable outcome | status | evidence path -->

## Assumptions
<!-- assumption | adopted default | rationale | reversible? -->

## Findings
<!-- cite repository paths and primary evidence -->

## Decisions

## Scope IN

## Scope OUT
<!-- Must NOT have -->

## Open questions

## Approval gate
status: drafting
approval: pending
<!-- Persist awaiting-approval before the brief; only a later explicit reply may approve. -->
`
}

export function buildPlan(slug, intent) {
  const decisionLabel =
    intent === "unclear" ? "Decisions I made for you" : "Decisions to sanity-check"
  return `# ${slug} - Work Plan

${PLAN_MARKER}

## TL;DR (For humans)
<!-- Fill this LAST after the detailed plan is stable. -->
**What you'll get:** <fill last>
**Why this approach:** <fill last>
**What it will NOT do:** <fill last>
**Effort:** <Quick | Short | Medium | Large | XL>
**Risk:** <Low | Medium | High> - <driver>
**${decisionLabel}:** <fill last>

---

> TL;DR (machine): <fill last>

## Scope
### Must have
### Must NOT have (guardrails, anti-slop, scope boundaries)

## Verification strategy
> Zero human intervention. Include agent-executed happy and failure QA.

## Execution strategy
### Parallel execution waves
### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |

## Todos
<!-- APPEND todo batches below this line. Never rewrite emitted headers. -->

## Final verification wave
- [ ] F1. Plan compliance audit
- [ ] F2. Code quality review
- [ ] F3. Real manual QA
- [ ] F4. Scope fidelity

## Commit strategy

## Success criteria
`
}

async function writeGuarded(path, content, state, options) {
  if (state.kind === "artifact") {
    if (!options.reset) return { path, status: "exists" }
    if (state.content.trim() !== content.trim() && !options.force) {
      throw new Error(`refused: artifact has edits; pass --reset --force to discard them: ${path}`)
    }
    await writeFile(path, content, "utf8")
    return { path, status: "reset" }
  }
  await writeFile(path, content, { encoding: "utf8", flag: "wx" })
  return { path, status: "created" }
}

export async function scaffold(cwd, options) {
  const paths = await inspectWorkspace(cwd, options.slug)
  await prepareDirectories(paths)
  const current = await inspectWorkspace(cwd, options.slug)
  if (options.mode === "draft") {
    return writeGuarded(
      current.draftPath,
      buildDraft(options.slug, options.intent),
      current.draft,
      options,
    )
  }
  if (current.draft.kind !== "artifact" || current.draft.content === null) {
    throw new Error("refused: --plan requires an existing omp-lazy draft")
  }
  if (!hasApproval(current.draft.content)) {
    throw new Error(
      "refused: --plan requires status: approved and approval: explicit-user-approval",
    )
  }
  const intent = /^intent: (clear|unclear)$/m.exec(current.draft.content)?.[1] ?? "unspecified"
  return writeGuarded(current.planPath, buildPlan(options.slug, intent), current.plan, options)
}

async function main() {
  const options = parseArgs(process.argv)
  const result = await scaffold(process.cwd(), options)
  process.stdout.write(`${result.status}: ${relative(process.cwd(), result.path)}\n`)
  process.stdout.write(
    options.mode === "draft"
      ? "next: record findings and persist explicit approval before running --plan.\n"
      : "next: append todos and fill the human TL;DR last.\n",
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
