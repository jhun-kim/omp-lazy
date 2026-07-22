import { describe, expect, it } from "bun:test"
import { readBaselineManifest } from "../../harness-eval/src/baseline-contract"
import { executeBaselineAdapters } from "../../harness-eval/src/baseline-runner"
import { repositoryRoot } from "../fixtures/package-test-helpers"

describe("baseline adapter streams", () => {
  it("returns the same JSON result when its fixture fills stderr beyond pipe capacity", async () => {
    // Given: the baseline adapter with and without a large stderr fixture.
    const { manifest } = await readBaselineManifest("harness-eval/manifest.v1.json")
    const expected = await executeBaselineAdapters(repositoryRoot, manifest)

    // When: the adapter writes 128 MiB to stderr before its valid JSON stdout.
    const actual = await executeBaselineAdapters(repositoryRoot, manifest, 128 * 1_048_576)

    // Then: evaluator-visible JSON remains identical after the stderr fixture completes.
    expect(actual).toEqual(expected)
  }, 10_000)
})
