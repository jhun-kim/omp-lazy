import { z } from "zod"
import type { ReceiptContract } from "./evidence-manifest-contract"
import {
  assertRelativeEvidencePath,
  EvidenceManifestError,
  inspectEvidenceFileBytes,
} from "./evidence-manifest-files"
import { HOSTILE_SCENARIO_IDS } from "./hostile-contract"

const rawReferenceSchema = z.strictObject({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
const processSchema = z
  .object({ stderr: rawReferenceSchema, stdout: rawReferenceSchema })
  .passthrough()
const scenarioSchema = z
  .object({ process: processSchema, scenarioId: z.string(), status: z.string() })
  .passthrough()
const verdictSchema = z.object({ results: z.array(scenarioSchema) }).passthrough()
const rejectSchema = scenarioSchema

export type RawEvidenceContract = ReceiptContract & { readonly declaredSha256: string }

function rawContract(reference: z.infer<typeof rawReferenceSchema>): RawEvidenceContract {
  const path = assertRelativeEvidencePath(reference.path, "escaping T14 raw evidence path")
  if (!path.startsWith("raw/")) {
    throw new EvidenceManifestError(`T14 raw evidence must be beneath raw/: ${path}`)
  }
  return { declaredSha256: reference.sha256, path: `T14/${path}`, producerTodo: "T14" }
}

function references(scenario: z.infer<typeof scenarioSchema>): readonly RawEvidenceContract[] {
  return [rawContract(scenario.process.stderr), rawContract(scenario.process.stdout)]
}

export async function t14RawEvidenceContracts(
  root: string,
): Promise<readonly RawEvidenceContract[]> {
  const [verdictFile, rejectFile] = await Promise.all([
    inspectEvidenceFileBytes(root, {
      path: "T14/hostile-verdict.json",
      producerTodo: "T14",
    }),
    inspectEvidenceFileBytes(root, {
      path: "T14/hostile-reject.json",
      producerTodo: "T14",
    }),
  ])
  const verdict = verdictSchema.parse(JSON.parse(new TextDecoder().decode(verdictFile.bytes)))
  const reject = rejectSchema.parse(JSON.parse(new TextDecoder().decode(rejectFile.bytes)))
  const scenarioIds = verdict.results.map((result) => result.scenarioId)
  if (JSON.stringify(scenarioIds) !== JSON.stringify(HOSTILE_SCENARIO_IDS)) {
    throw new EvidenceManifestError("T14 hostile verdict must contain G01-G25 exactly once")
  }
  const contracts = [...verdict.results.flatMap(references), ...references(reject)]
  const paths = contracts.map((contract) => contract.path)
  if (new Set(paths).size !== paths.length) {
    throw new EvidenceManifestError("duplicate T14 raw evidence reference")
  }
  return contracts.toSorted((left, right) => left.path.localeCompare(right.path))
}
