import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { z } from "zod"
import {
  type EvidenceEntry,
  type EvidenceManifest,
  REVIEW_RECEIPTS,
  SOURCE_RECEIPTS,
  type SourceManifest,
  sourceManifestSchema,
} from "./evidence-manifest-contract"
import {
  EvidenceManifestError,
  inspectEvidenceFile,
  listEvidenceFiles,
} from "./evidence-manifest-files"
import { type RawEvidenceContract, t14RawEvidenceContracts } from "./t14-evidence-references"

export { EvidenceManifestError } from "./evidence-manifest-files"

type BuildOptions = {
  readonly commit: string
  readonly mode: "review" | "source"
  readonly root: string
}

const commitSchema = z.string().regex(/^[a-f0-9]{40}$/)

async function sourceContracts(root: string): Promise<readonly RawEvidenceContract[]> {
  const raw = await t14RawEvidenceContracts(root)
  return [
    ...SOURCE_RECEIPTS.map((receipt) => ({ ...receipt, declaredSha256: "" })),
    ...raw,
  ].toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

function assertExactPaths(actual: readonly string[], expected: readonly string[]): void {
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  const missing = expected.find((path) => !actualSet.has(path))
  if (missing !== undefined) throw new EvidenceManifestError(`missing evidence file: ${missing}`)
  const unexpected = actual.find((path) => !expectedSet.has(path))
  if (unexpected !== undefined) {
    throw new EvidenceManifestError(`unexpected evidence file: ${unexpected}`)
  }
}

async function inspectSourceEntries(
  root: string,
  contracts: readonly RawEvidenceContract[],
): Promise<readonly EvidenceEntry[]> {
  const entries = await Promise.all(
    contracts.map((contract) => inspectEvidenceFile(root, contract)),
  )
  for (let index = 0; index < contracts.length; index += 1) {
    const contract = contracts[index]
    const entry = entries[index]
    if (
      contract !== undefined &&
      entry !== undefined &&
      contract.declaredSha256.length > 0 &&
      contract.declaredSha256 !== entry.sha256
    ) {
      throw new EvidenceManifestError(`T14 raw evidence hash mismatch: ${entry.path}`)
    }
  }
  return entries
}

function assertApproval(path: string, contents: string): void {
  if (path.endsWith("F3-real-qa.json")) {
    const parsed = z
      .object({ verdict: z.literal("APPROVE") })
      .passthrough()
      .safeParse(JSON.parse(contents))
    if (!parsed.success) {
      throw new EvidenceManifestError(`review receipt is not unconditional APPROVE: ${path}`)
    }
    return
  }
  const verdicts = contents
    .split(/\r?\n/)
    .map((line) => /^Verdict:\s*(.+)\s*$/.exec(line)?.[1]?.trim())
    .filter((verdict): verdict is string => verdict !== undefined)
  if (verdicts.length !== 1 || verdicts[0] !== "APPROVE") {
    throw new EvidenceManifestError(`review receipt is not unconditional APPROVE: ${path}`)
  }
}

async function validateSourceManifest(
  root: string,
  commit: string,
  contracts: readonly RawEvidenceContract[],
): Promise<SourceManifest> {
  const path = resolve(root, "final", "evidence-manifest.json")
  const manifest = sourceManifestSchema.parse(JSON.parse(await readFile(path, "utf8")))
  if (manifest.commit !== commit) throw new EvidenceManifestError("source manifest commit mismatch")
  if (manifest.evidenceRoot !== root) {
    throw new EvidenceManifestError("source manifest evidence root mismatch")
  }
  const entries = await inspectSourceEntries(root, contracts)
  if (JSON.stringify(manifest.entries) !== JSON.stringify(entries)) {
    throw new EvidenceManifestError("source manifest entries or hashes changed")
  }
  return manifest
}

async function writeManifest(root: string, manifest: EvidenceManifest): Promise<void> {
  const name = manifest.mode === "source" ? "evidence-manifest.json" : "review-manifest.json"
  const path = resolve(root, "final", name)
  await mkdir(dirname(path), { recursive: true })
  await rm(path, { force: true })
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" })
  await chmod(path, 0o444)
}

export async function buildEvidenceManifest(options: BuildOptions): Promise<EvidenceManifest> {
  const commit = commitSchema.parse(options.commit)
  const root = await realpath(resolve(options.root))
  const contracts = await sourceContracts(root)
  const sourcePaths = contracts.map((contract) => contract.path)
  const output =
    options.mode === "source" ? "final/evidence-manifest.json" : "final/review-manifest.json"
  const actual = (await listEvidenceFiles(root)).filter((path) => path !== output)

  if (options.mode === "source") {
    assertExactPaths(actual, sourcePaths)
    const manifest: EvidenceManifest = {
      commit,
      entries: await inspectSourceEntries(root, contracts),
      evidenceRoot: root,
      mode: "source",
      schemaVersion: 1,
    }
    await writeManifest(root, manifest)
    return manifest
  }

  const sourceManifestPath = "final/evidence-manifest.json"
  const reviewPaths = REVIEW_RECEIPTS.map((receipt) => receipt.path)
  assertExactPaths(actual, [...sourcePaths, sourceManifestPath, ...reviewPaths].toSorted())
  await validateSourceManifest(root, commit, contracts)
  const entries = await Promise.all(
    REVIEW_RECEIPTS.map((receipt) => inspectEvidenceFile(root, receipt)),
  )
  for (const receipt of REVIEW_RECEIPTS) {
    if (receipt.approval) {
      assertApproval(receipt.path, await readFile(resolve(root, receipt.path), "utf8"))
    }
  }
  const sourceEntry = await inspectEvidenceFile(root, {
    path: sourceManifestPath,
    producerTodo: "T15",
  })
  const manifest: EvidenceManifest = {
    commit,
    entries,
    evidenceRoot: root,
    mode: "review",
    schemaVersion: 1,
    sourceManifest: {
      bytes: sourceEntry.bytes,
      path: sourceManifestPath,
      sha256: sourceEntry.sha256,
    },
  }
  await writeManifest(root, manifest)
  return manifest
}
