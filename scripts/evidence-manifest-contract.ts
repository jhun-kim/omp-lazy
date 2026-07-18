import { z } from "zod"

const shaSchema = z.string().regex(/^[a-f0-9]{64}$/)
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/)

export type ReceiptContract = {
  readonly path: string
  readonly producerTodo: string
}

const plannedReceipts = [
  ["T01/delta-classification.json", "T01"],
  ["T01/classification-pass.txt", "T01"],
  ["T01/classification-reject.txt", "T01"],
  ["T01/discovery-invocation-red.txt", "T01"],
  ["T01/dogfood-missing-script-red.txt", "T01"],
  ["T01/hostile-timeout-red.txt", "T01"],
  ["T01/link-doctor-red.txt", "T01"],
  ["T01/manifest-load-red.txt", "T01"],
  ["T01/preflight-invocation-red.txt", "T01"],
  ["T01/staged-smoke-red.txt", "T01"],
  ["T02/runtime-contract.txt", "T02"],
  ["T02/missing-entry.txt", "T02"],
  ["T03/discovery-pass.json", "T03"],
  ["T03/missing-attribution.txt", "T03"],
  ["T04/contained-pass.txt", "T04"],
  ["T04/escape-reject.txt", "T04"],
  ["T05/loader-pass.json", "T05"],
  ["T05/duplicate-reject.json", "T05"],
  ["T06/dispatcher-pass.txt", "T06"],
  ["T06/dispatcher-reject.txt", "T06"],
  ["T07/skill-sync.json", "T07"],
  ["T07/skill-reject.txt", "T07"],
  ["T08/product-inventory.json", "T08"],
  ["T08/inventory-reject.txt", "T08"],
  ["T09/typecheck-pass.txt", "T09"],
  ["T09/typecheck-reject.txt", "T09"],
  ["T10/package-inspect.json", "T10"],
  ["T10/package-reject.txt", "T10"],
  ["T11/loader.json", "T11"],
  ["T11/discovery.json", "T11"],
  ["T11/product-mode-reject.txt", "T11"],
  ["T12/pack-candidate.json", "T12"],
  ["T12/staged-verdict.json", "T12"],
  ["T12/staged-reject.txt", "T12"],
  ["T13/real-omp-verdict.json", "T13"],
  ["T13/real-omp-reject.txt", "T13"],
  ["T14/hostile-verdict.json", "T14"],
  ["T14/hostile-reject.json", "T14"],
  ["T14/first-failure.json", "T14"],
  ["T15/docs-and-gates.txt", "T15"],
  ["T15/readme-contract.json", "T15"],
  ["T15/release-reject.txt", "T15"],
] as const

export const SOURCE_RECEIPTS: readonly ReceiptContract[] = [
  ...plannedReceipts.map(([path, producerTodo]) => ({ path, producerTodo })),
  ...Array.from({ length: 25 }, (_, index) => ({
    path: `T14/G${String(index + 1).padStart(2, "0")}.json`,
    producerTodo: "T14",
  })),
]

export const REVIEW_RECEIPTS = [
  { approval: true, path: "final/F1-plan-compliance.md", producerTodo: "F1" },
  { approval: true, path: "final/F2-quality-security.md", producerTodo: "F2" },
  { approval: false, path: "final/F2-verify-release.txt", producerTodo: "F2" },
  { approval: true, path: "final/F3-real-qa.json", producerTodo: "F3" },
  { approval: true, path: "final/F4-scope-fidelity.md", producerTodo: "F4" },
] as const

export const manifestEntrySchema = z.strictObject({
  absolutePath: z.string().min(1),
  bytes: z.number().int().positive(),
  mediaType: z.string().min(1),
  path: z.string().min(1),
  producerTodo: z.string().regex(/^(?:T(?:0[1-9]|1[0-5])|F[1-4])$/),
  sha256: shaSchema,
})

export const sourceManifestSchema = z.strictObject({
  commit: commitSchema,
  entries: z.array(manifestEntrySchema).readonly(),
  evidenceRoot: z.string().min(1),
  mode: z.literal("source"),
  schemaVersion: z.literal(1),
})

export type EvidenceEntry = z.infer<typeof manifestEntrySchema>
export type SourceManifest = z.infer<typeof sourceManifestSchema>
export type EvidenceManifest = {
  readonly commit: string
  readonly entries: readonly EvidenceEntry[]
  readonly evidenceRoot: string
  readonly mode: "review" | "source"
  readonly schemaVersion: 1
  readonly sourceManifest?: {
    readonly bytes: number
    readonly path: "final/evidence-manifest.json"
    readonly sha256: string
  }
}
