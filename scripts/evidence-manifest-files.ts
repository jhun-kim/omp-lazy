import { lstat, open, readdir, realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import type { EvidenceEntry, ReceiptContract } from "./evidence-manifest-contract"

export class EvidenceManifestError extends Error {
  override readonly name = "EvidenceManifestError"
}

export type EvidenceInspectionHooks = {
  readonly afterPathValidation?: () => Promise<void>
  readonly afterRead?: () => Promise<void>
}

export type InspectedEvidenceFile = {
  readonly bytes: Uint8Array
  readonly entry: EvidenceEntry
}

function contained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
}

function sameFile(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameSnapshot(
  left: {
    readonly ctimeMs: number
    readonly dev: number
    readonly ino: number
    readonly mtimeMs: number
    readonly size: number
  },
  right: {
    readonly ctimeMs: number
    readonly dev: number
    readonly ino: number
    readonly mtimeMs: number
    readonly size: number
  },
): boolean {
  return (
    sameFile(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function samePath(left: string, right: string): boolean {
  return contained(left, right) && contained(right, left)
}

export function normalizeEvidencePath(path: string): string {
  return path.replaceAll("\\", "/")
}

export function assertRelativeEvidencePath(path: string, label: string): string {
  const normalized = normalizeEvidencePath(path)
  const candidate = resolve("/evidence-root", normalized)
  if (
    normalized.length === 0 ||
    isAbsolute(normalized) ||
    normalized.split("/").includes("..") ||
    !contained("/evidence-root", candidate)
  ) {
    throw new EvidenceManifestError(`${label}: ${path}`)
  }
  return normalized
}

export async function listEvidenceFiles(root: string): Promise<readonly string[]> {
  const files: string[] = []
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(resolve(root, directory), { withFileTypes: true })
    for (const entry of entries) {
      const path = normalizeEvidencePath(
        directory.length === 0 ? entry.name : `${directory}/${entry.name}`,
      )
      if (entry.isDirectory()) await visit(path)
      else files.push(path)
    }
  }
  await visit("")
  return files.toSorted()
}

function mediaType(path: string): string {
  if (path.endsWith(".json")) return "application/json"
  if (path.endsWith(".md")) return "text/markdown"
  if (path.endsWith(".txt")) return "text/plain"
  return "application/octet-stream"
}

export async function inspectEvidenceFileBytes(
  root: string,
  contract: ReceiptContract,
  hooks: EvidenceInspectionHooks = {},
): Promise<InspectedEvidenceFile> {
  const path = assertRelativeEvidencePath(contract.path, "escaping evidence path")
  const candidate = resolve(root, path)
  if (!contained(root, candidate))
    throw new EvidenceManifestError(`escaping evidence path: ${path}`)
  const metadata = await lstat(candidate).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new EvidenceManifestError(`missing evidence file: ${path}`)
    throw error
  })
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new EvidenceManifestError(`evidence is not a regular file: ${path}`)
  }
  const handle = await open(candidate, "r")
  try {
    const canonicalRoot = await realpath(root)
    const canonical = await realpath(candidate)
    const [openedMetadata, canonicalMetadata] = await Promise.all([handle.stat(), stat(canonical)])
    if (
      !contained(canonicalRoot, canonical) ||
      !openedMetadata.isFile() ||
      !canonicalMetadata.isFile() ||
      !sameFile(openedMetadata, canonicalMetadata)
    ) {
      throw new EvidenceManifestError(`evidence realpath escaped root: ${path}`)
    }
    try {
      await hooks.afterPathValidation?.()
    } catch (error) {
      if (error instanceof Error) {
        throw new EvidenceManifestError(`evidence identity changed: ${path}`, { cause: error })
      }
      throw error
    }
    const bytes = await handle.readFile()
    await hooks.afterRead?.()
    const afterReadMetadata = await handle.stat()
    const currentCanonical = await realpath(candidate)
    const currentMetadata = await stat(currentCanonical)
    if (
      !afterReadMetadata.isFile() ||
      !sameSnapshot(openedMetadata, afterReadMetadata) ||
      !contained(canonicalRoot, currentCanonical) ||
      !samePath(canonical, currentCanonical) ||
      !sameFile(afterReadMetadata, currentMetadata)
    ) {
      throw new EvidenceManifestError(`evidence identity changed: ${path}`)
    }
    if (bytes.byteLength === 0) throw new EvidenceManifestError(`empty evidence file: ${path}`)
    return {
      bytes,
      entry: {
        absolutePath: canonical,
        bytes: bytes.byteLength,
        mediaType: mediaType(path),
        path,
        producerTodo: contract.producerTodo,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      },
    }
  } finally {
    await handle.close()
  }
}

export async function inspectEvidenceFile(
  root: string,
  contract: ReceiptContract,
  hooks: EvidenceInspectionHooks = {},
): Promise<EvidenceEntry> {
  return (await inspectEvidenceFileBytes(root, contract, hooks)).entry
}
