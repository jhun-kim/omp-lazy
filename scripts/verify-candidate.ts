import { readFile, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { evidenceBundleSchema } from "./evidence-contract"

type CandidateAssessment = { readonly status: "PASS" | "FAIL"; readonly reasons: readonly string[] }

function contained(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path !== "" && !path.startsWith("..") && !isAbsolute(path)
}

export async function verifyEvidenceBundle(bundlePath: string): Promise<CandidateAssessment> {
  const absoluteBundle = resolve(bundlePath)
  const root = await realpath(dirname(absoluteBundle))
  const parsed = evidenceBundleSchema.safeParse(JSON.parse(await readFile(absoluteBundle, "utf8")))
  if (!parsed.success) return { status: "FAIL", reasons: ["invalid evidence schema"] }
  const reasons: string[] = []
  if (
    parsed.data.principal.role === "executor" &&
    parsed.data.results.some((result) => result.scenarioId === "G01" && result.status === "PASS")
  ) {
    reasons.push("executor bundle cannot attest G01")
  }
  for (const result of parsed.data.results) {
    if (result.status !== "PASS")
      reasons.push(`scenario is non-PASS: ${result.scenarioId}/${result.status}`)
    if (result.process.timedOut || result.process.exitCode !== 0) {
      reasons.push(`scenario process failed: ${result.scenarioId}`)
    }
    for (const reference of [result.process.stdout, result.process.stderr]) {
      const candidate = resolve(root, reference.path)
      if (!contained(root, candidate)) {
        reasons.push(`escaping raw evidence: ${reference.path}`)
        continue
      }
      try {
        const resolved = await realpath(candidate)
        const metadata = await stat(resolved)
        if (!contained(root, resolved) || !metadata.isFile())
          reasons.push(`invalid raw evidence: ${reference.path}`)
        else if (
          new Bun.CryptoHasher("sha256")
            .update(await Bun.file(resolved).arrayBuffer())
            .digest("hex") !== reference.sha256
        )
          reasons.push(`raw evidence hash mismatch: ${reference.path}`)
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
          reasons.push(`missing raw evidence: ${reference.path}`)
        else throw error
      }
    }
  }
  return { status: reasons.length === 0 ? "PASS" : "FAIL", reasons }
}

async function main(): Promise<void> {
  // no-excuse-ok: catch -- CLI boundary converts failures into a nonzero result.
  try {
    const bundleIndex = Bun.argv.indexOf("--bundle")
    const bundle = bundleIndex < 0 ? undefined : Bun.argv[bundleIndex + 1]
    if (bundle === undefined)
      throw new TypeError("usage: verify-candidate.ts --bundle <verdict.json>")
    const assessment = await verifyEvidenceBundle(bundle)
    process.stdout.write(`${JSON.stringify(assessment)}\n`)
    process.exitCode = assessment.status === "PASS" ? 0 : 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

if (import.meta.main) await main()
