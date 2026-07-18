import { readFile } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { z } from "zod"

export const BASE_COMMIT = "ac290bec0b55cded997fa7108ec65ab7f62d6e07"
export const CANDIDATE_COMMIT = "5610e51c44234a95fe5f54f2dd1557e17df86551"

const commitShaSchema = z.string().regex(/^[a-f0-9]{40}$/)
const categorySchema = z.enum([
  "runtime",
  "skill",
  "agent",
  "test",
  "package",
  "security",
  "documentation",
  "generated",
  "out-of-scope",
])
const decisionSchema = z.enum(["adopt", "adapt", "reject"])
const statusSchema = z.string().regex(/^[A-Z][0-9]*$/)
const relativePathSchema = z
  .string()
  .min(1)
  .refine(
    (path) => !isAbsolute(path) && !path.replaceAll("\\", "/").split("/").includes(".."),
    "path must be repository-relative",
  )

const entrySchema = z.strictObject({
  path: relativePathSchema,
  status: statusSchema,
  category: categorySchema,
  decision: decisionSchema,
  sourceCommit: commitShaSchema,
})

const classificationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  frozenRange: z.strictObject({ base: commitShaSchema, candidate: commitShaSchema }),
  entries: z.array(entrySchema).readonly(),
})

const cliArgumentsSchema = z.strictObject({
  classificationPath: z.string().min(1),
  base: commitShaSchema,
  candidate: commitShaSchema,
})

export type DeltaClassificationDocument = z.infer<typeof classificationSchema>
export type VerifyDeltaArguments = z.infer<typeof cliArgumentsSchema>

export type DeltaAssessment = {
  readonly status: "PASS" | "FAIL"
  readonly base: string
  readonly candidate: string
  readonly pathCount: number
  readonly classifiedCount: number
  readonly reasons: readonly string[]
}

class DeltaClassificationError extends Error {
  readonly name = "DeltaClassificationError"
}

type GitCommandResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

type DiffEntry = {
  readonly path: string
  readonly status: string
}

type PartialCliArguments = {
  classificationPath?: string
  base?: string
  candidate?: string
}

function runGit(arguments_: readonly string[]): GitCommandResult {
  const result = Bun.spawnSync({
    cmd: ["git", ...arguments_],
    stderr: "pipe",
    stdout: "pipe",
  })
  const decoder = new TextDecoder()
  return {
    exitCode: result.exitCode,
    stderr: decoder.decode(result.stderr),
    stdout: decoder.decode(result.stdout),
  }
}

function parseCliArguments(rawArguments: readonly string[]): VerifyDeltaArguments {
  const parsedValues: PartialCliArguments = {}
  for (let index = 0; index < rawArguments.length; index += 2) {
    const flag = rawArguments[index]
    const value = rawArguments[index + 1]
    if (flag === undefined || value === undefined) break
    switch (flag) {
      case "--classification":
        parsedValues.classificationPath = value
        break
      case "--base":
        parsedValues.base = value
        break
      case "--candidate":
        parsedValues.candidate = value
        break
      default:
        throw new DeltaClassificationError(`unknown argument: ${flag}`)
    }
  }
  const result = cliArgumentsSchema.safeParse(parsedValues)
  if (!result.success) {
    throw new DeltaClassificationError(`invalid CLI arguments: ${formatZodIssues(result.error)}`)
  }
  return result.data
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ")
}

function parseDiff(stdout: string): readonly DiffEntry[] {
  const entries: DiffEntry[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (line.length === 0) continue
    const parts = line.split("\t")
    const status = parts[0]
    const path = parts[parts.length - 1]
    if (status === undefined || path === undefined) {
      throw new DeltaClassificationError(`invalid git diff line: ${line}`)
    }
    entries.push({ status, path })
  }
  return entries
}

function resolvedCommit(sha: string): string {
  const result = runGit(["rev-parse", "--verify", `${sha}^{commit}`])
  if (result.exitCode !== 0) {
    throw new DeltaClassificationError(`commit does not resolve: ${sha}: ${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

function requireExpectedCommit(label: string, actual: string, expected: string): readonly string[] {
  return actual === expected ? [] : [`${label} drift: expected ${expected}, got ${actual}`]
}

function sourceCommitsInRange(base: string, candidate: string): ReadonlySet<string> {
  const result = runGit(["rev-list", `${base}..${candidate}`])
  if (result.exitCode !== 0) {
    throw new DeltaClassificationError(`git rev-list failed: ${result.stderr.trim()}`)
  }
  return new Set(result.stdout.split(/\r?\n/).filter((line) => line.length > 0))
}

function compareClassification(
  classification: DeltaClassificationDocument,
  diffEntries: readonly DiffEntry[],
  arguments_: VerifyDeltaArguments,
  validSourceCommits: ReadonlySet<string>,
): readonly string[] {
  const reasons: string[] = []
  reasons.push(...requireExpectedCommit("base", arguments_.base, BASE_COMMIT))
  reasons.push(...requireExpectedCommit("candidate", arguments_.candidate, CANDIDATE_COMMIT))
  reasons.push(
    ...requireExpectedCommit(
      "classification base",
      classification.frozenRange.base,
      arguments_.base,
    ),
  )
  reasons.push(
    ...requireExpectedCommit(
      "classification candidate",
      classification.frozenRange.candidate,
      arguments_.candidate,
    ),
  )

  const expectedByPath = new Map(diffEntries.map((entry) => [entry.path, entry.status]))
  const seen = new Set<string>()
  for (const entry of classification.entries) {
    if (seen.has(entry.path)) reasons.push(`duplicate path: ${entry.path}`)
    seen.add(entry.path)
    const expectedStatus = expectedByPath.get(entry.path)
    if (expectedStatus === undefined) {
      reasons.push(`unexpected path: ${entry.path}`)
    } else if (expectedStatus !== entry.status) {
      reasons.push(
        `status mismatch for ${entry.path}: expected ${expectedStatus}, got ${entry.status}`,
      )
    }
    if (!validSourceCommits.has(entry.sourceCommit)) {
      reasons.push(`source commit outside frozen range for ${entry.path}: ${entry.sourceCommit}`)
    }
  }

  for (const expectedPath of expectedByPath.keys()) {
    if (!seen.has(expectedPath)) reasons.push(`omitted path: ${expectedPath}`)
  }
  return reasons
}

export async function verifyDeltaClassification(
  arguments_: VerifyDeltaArguments,
): Promise<DeltaAssessment> {
  const resolvedBase = resolvedCommit(arguments_.base)
  const resolvedCandidate = resolvedCommit(arguments_.candidate)
  const diffResult = runGit([
    "diff",
    "--name-status",
    `${arguments_.base}..${arguments_.candidate}`,
  ])
  if (diffResult.exitCode !== 0) {
    throw new DeltaClassificationError(`git diff failed: ${diffResult.stderr.trim()}`)
  }
  const rawJson: unknown = JSON.parse(await readFile(arguments_.classificationPath, "utf8"))
  const parsedClassification = classificationSchema.safeParse(rawJson)
  const diffEntries = parseDiff(diffResult.stdout)
  const validSourceCommits = sourceCommitsInRange(arguments_.base, arguments_.candidate)
  if (!parsedClassification.success) {
    return {
      status: "FAIL",
      base: resolvedBase,
      candidate: resolvedCandidate,
      pathCount: diffEntries.length,
      classifiedCount: 0,
      reasons: [`invalid classification JSON: ${formatZodIssues(parsedClassification.error)}`],
    }
  }
  const reasons = compareClassification(
    parsedClassification.data,
    diffEntries,
    arguments_,
    validSourceCommits,
  )
  return {
    status: reasons.length === 0 ? "PASS" : "FAIL",
    base: resolvedBase,
    candidate: resolvedCandidate,
    pathCount: diffEntries.length,
    classifiedCount: parsedClassification.data.entries.length,
    reasons,
  }
}

async function main(): Promise<void> {
  // no-excuse-ok: catch -- CLI boundary converts typed verification failures into stderr and exit 1.
  try {
    const assessment = await verifyDeltaClassification(parseCliArguments(Bun.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(assessment)}\n`)
    process.exitCode = assessment.status === "PASS" ? 0 : 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

if (import.meta.main) await main()
