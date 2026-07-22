import { createHash } from "node:crypto"
import { lstat, open, realpath } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import type { CanonicalRoot } from "../state/domain"
import {
  canonicalComparisonPath,
  isCanonicalPathContained,
  isDisplayPathContained,
} from "../state/paths"
import {
  CleanupReceiptSchema,
  cleanupClaimsForEvidence,
  isLegacyCleanupEvidence,
  type WorkerEvidenceReceipt,
  WorkerEvidenceReceiptSchema,
} from "./evidence-receipt"

const MAX_RECEIPT_BYTES = 256 * 1_024
const MAX_ARTIFACT_BYTES = 16 * 1_024 * 1_024
const MAX_BUNDLE_BYTES = 64 * 1_024 * 1_024

export type ContainedFile = {
  readonly displayPath: string
  readonly relativePath: string
  readonly size: number
  readonly sha256: string
  readonly bytes: Uint8Array
}

export type EvidenceBundle = {
  readonly receipt: WorkerEvidenceReceipt
  readonly receiptFile: ContainedFile
  readonly artifacts: readonly ContainedFile[]
  readonly cleanupReceipts: readonly ContainedFile[]
  readonly artifactHash: string
}

export type ArtifactResult =
  | { readonly ok: true; readonly value: EvidenceBundle }
  | { readonly ok: false; readonly code: string }

export function evidenceRootPath(root: CanonicalRoot, runId: string, attempt: number): string {
  return join(
    root.displayPath,
    ".omo",
    "omp-lazy",
    "runs",
    runId,
    "attempts",
    String(attempt),
    "evidence",
  )
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

async function containedFile(options: {
  readonly repository: CanonicalRoot
  readonly evidenceRoot: string
  readonly advertisedPath: string
  readonly maximumBytes: number
}): Promise<{ readonly ok: true; readonly value: ContainedFile } | { readonly ok: false }> {
  const candidate = isAbsolute(options.advertisedPath)
    ? resolve(options.advertisedPath)
    : resolve(options.repository.displayPath, options.advertisedPath)
  if (!isDisplayPathContained(options.evidenceRoot, candidate)) return { ok: false }
  try {
    const rootReal = await realpath(options.evidenceRoot)
    if (
      !isCanonicalPathContained(options.repository.canonicalPath, canonicalComparisonPath(rootReal))
    ) {
      return { ok: false }
    }
    const before = await lstat(candidate)
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.size === 0 ||
      before.size > options.maximumBytes
    ) {
      return { ok: false }
    }
    const candidateReal = await realpath(candidate)
    if (
      !isCanonicalPathContained(
        canonicalComparisonPath(rootReal),
        canonicalComparisonPath(candidateReal),
      )
    ) {
      return { ok: false }
    }
    const handle = await open(candidateReal, "r")
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.size !== before.size || opened.size > options.maximumBytes) {
        return { ok: false }
      }
      const bytes = await handle.readFile()
      const after = await handle.stat()
      if (
        bytes.byteLength !== opened.size ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs
      ) {
        return { ok: false }
      }
      return {
        ok: true,
        value: {
          displayPath: candidateReal,
          relativePath: candidateReal.slice(rootReal.length + 1).replaceAll("\\", "/"),
          size: bytes.byteLength,
          sha256: sha256(bytes),
          bytes,
        },
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error instanceof Error) return { ok: false }
    throw error
  }
}

function decodeReceipt(bytes: Uint8Array): WorkerEvidenceReceipt | null {
  try {
    const parsed = WorkerEvidenceReceiptSchema.safeParse(
      JSON.parse(new TextDecoder().decode(bytes)),
    )
    return parsed.success ? parsed.data : null
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

export async function validateEvidenceBundle(
  repository: CanonicalRoot,
  runId: string,
  attempt: number,
  receiptPath: string,
): Promise<ArtifactResult> {
  const evidenceRoot = evidenceRootPath(repository, runId, attempt)
  const receiptFile = await containedFile({
    repository,
    evidenceRoot,
    advertisedPath: receiptPath,
    maximumBytes: MAX_RECEIPT_BYTES,
  })
  if (!receiptFile.ok) return { ok: false, code: "invalid_receipt_file" }
  const receipt = decodeReceipt(receiptFile.value.bytes)
  if (receipt === null) return { ok: false, code: "malformed_receipt" }
  if (
    !isLegacyCleanupEvidence(receipt.cleanup) &&
    receipt.cleanup.status === "not_applicable" &&
    receipt.resources.length > 0
  ) {
    return { ok: false, code: "cleanup_required" }
  }

  const artifacts: ContainedFile[] = []
  for (const claim of receipt.artifacts) {
    const artifact = await containedFile({
      repository,
      evidenceRoot,
      advertisedPath: claim.path,
      maximumBytes: MAX_ARTIFACT_BYTES,
    })
    if (!artifact.ok) return { ok: false, code: "invalid_artifact" }
    artifacts.push(artifact.value)
  }
  const cleanupReceipts: ContainedFile[] = []
  const cleanupClaims = cleanupClaimsForEvidence(receipt.cleanup)
  for (const claim of cleanupClaims) {
    const file = await containedFile({
      repository,
      evidenceRoot,
      advertisedPath: claim.receiptPath,
      maximumBytes: MAX_RECEIPT_BYTES,
    })
    if (!file.ok) return { ok: false, code: "invalid_cleanup_receipt" }
    let decoded: unknown
    try {
      decoded = JSON.parse(new TextDecoder().decode(file.value.bytes))
    } catch (error) {
      if (error instanceof SyntaxError) return { ok: false, code: "invalid_cleanup_receipt" }
      throw error
    }
    const cleanup = CleanupReceiptSchema.safeParse(decoded)
    if (
      !cleanup.success ||
      cleanup.data.resourceId !== claim.resourceId ||
      cleanup.data.runId !== receipt.runId ||
      cleanup.data.attempt !== receipt.attempt ||
      cleanup.data.actualAgentId !== receipt.actualAgentId ||
      cleanup.data.captureCommit !== receipt.captureCommit
    ) {
      return { ok: false, code: "invalid_cleanup_receipt" }
    }
    cleanupReceipts.push(file.value)
  }
  const all = [receiptFile.value, ...artifacts, ...cleanupReceipts]
  if (new Set(all.map((file) => canonicalComparisonPath(file.displayPath))).size !== all.length) {
    return { ok: false, code: "duplicate_evidence_path" }
  }
  if (all.reduce((sum, file) => sum + file.size, 0) > MAX_BUNDLE_BYTES) {
    return { ok: false, code: "evidence_too_large" }
  }
  const artifactHash = sha256(
    new TextEncoder().encode(
      artifacts.map((file) => `${file.relativePath}\u0000${file.sha256}`).join("\u0000"),
    ),
  )
  return {
    ok: true,
    value: { receipt, receiptFile: receiptFile.value, artifacts, cleanupReceipts, artifactHash },
  }
}
