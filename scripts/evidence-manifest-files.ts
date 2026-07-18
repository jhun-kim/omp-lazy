import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import type { EvidenceEntry, ReceiptContract } from "./evidence-manifest-contract"

export class EvidenceManifestError extends Error {
  override readonly name = "EvidenceManifestError"
}

function contained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
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

export async function inspectEvidenceFile(
  root: string,
  contract: ReceiptContract,
): Promise<EvidenceEntry> {
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
  const canonical = await realpath(candidate)
  const canonicalMetadata = await stat(canonical)
  if (!contained(root, canonical) || !canonicalMetadata.isFile()) {
    throw new EvidenceManifestError(`evidence realpath escaped root: ${path}`)
  }
  const bytes = await readFile(canonical)
  if (bytes.byteLength === 0) throw new EvidenceManifestError(`empty evidence file: ${path}`)
  return {
    absolutePath: canonical,
    bytes: bytes.byteLength,
    mediaType: mediaType(path),
    path,
    producerTodo: contract.producerTodo,
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
  }
}
