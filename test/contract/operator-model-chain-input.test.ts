/**
 * Contract test: operator model-chain override input loading (todo 20).
 *
 * Tests:
 * - Absent file resolves to ABSENT (alias-only chains, no error)
 * - A valid override changes the chain for exactly the named agents
 * - A schema-invalid file yields `invalid_resolution_input` with no partial application
 * - A path outside `.omo/inputs` is refused with `path_outside_inputs`
 * - A schema whose sha256 does not match its sidecar is refused with `schema_integrity_mismatch`
 */
import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ModelChainInputReceipt,
  readModelChainInput,
  toAgentModelOverrides,
} from "../../src/workflows/operator-model-chain-input"

const sandboxes: string[] = []

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((s) => rm(s, { recursive: true, force: true })))
})

async function makeSandbox(): Promise<string> {
  const sandbox = await mkdtemp(join(tmpdir(), "omp-lazy-mcin-"))
  sandboxes.push(sandbox)
  return sandbox
}

/** Create a sandbox with a valid schema and sidecar. */
async function makeSandboxWithSchema(sandbox: string): Promise<void> {
  const schemasDir = join(sandbox, "schemas")
  await mkdir(schemasDir, { recursive: true })

  // Copy the real schema content
  const schemaContent = JSON.stringify(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      additionalProperties: false,
      properties: {
        schemaVersion: { const: 1, type: "integer" },
        overrides: {
          additionalProperties: false,
          patternProperties: {
            "^omp-lazy-(worker-low|worker-medium|worker-high|explorer|librarian|researcher|planner|metis|momus|qa|reviewer)$":
              {
                items: {
                  pattern: "^@(smol|task|slow)$|^[a-z][a-z0-9._-]{0,63}/[a-z][a-z0-9._-]{0,63}$",
                  type: "string",
                },
                maxItems: 8,
                minItems: 1,
                type: "array",
              },
          },
          type: "object",
        },
      },
      required: ["schemaVersion", "overrides"],
      type: "object",
    },
    null,
    2,
  )
  const schemaBytes = Buffer.from(schemaContent, "utf8")
  const hash = createHash("sha256").update(schemaBytes).digest("hex")

  await writeFile(join(schemasDir, "model-chain-input.schema.v1.json"), schemaBytes)
  await writeFile(join(schemasDir, "model-chain-input.schema.v1.sha256"), `${hash}\n`)
}

describe("operator model-chain input loading (todo 20)", () => {
  test("absent file resolves to ABSENT (alias-only chains, no error)", async () => {
    const sandbox = await makeSandbox()
    await makeSandboxWithSchema(sandbox)

    // No .omo/inputs/model-chain.v1.json exists
    const receipt = await readModelChainInput(sandbox)

    expect(receipt.status).toBe("ABSENT")
    // toAgentModelOverrides returns null for absent
    const overrides = toAgentModelOverrides(receipt)
    expect(overrides).toBeNull()
  })

  test("valid override changes the chain for exactly the named agents", async () => {
    const sandbox = await makeSandbox()
    await makeSandboxWithSchema(sandbox)

    // Create a valid input file
    const inputsDir = join(sandbox, ".omo", "inputs")
    await mkdir(inputsDir, { recursive: true })
    const validInput = {
      schemaVersion: 1,
      overrides: {
        "omp-lazy-worker-low": ["@task", "@slow"],
        "omp-lazy-planner": ["@slow"],
      },
    }
    await writeFile(join(inputsDir, "model-chain.v1.json"), JSON.stringify(validInput))

    const receipt = await readModelChainInput(sandbox)

    expect(receipt.status).toBe("PASS")
    if (receipt.status === "PASS") {
      expect(receipt.value.schemaVersion).toBe(1)
      expect(receipt.value.overrides).toEqual({
        "omp-lazy-worker-low": ["@task", "@slow"],
        "omp-lazy-planner": ["@slow"],
      })
    }

    // toAgentModelOverrides extracts the override record
    const result = toAgentModelOverrides(receipt)
    expect(result).not.toBeNull()
    expect(result?.overrides).toEqual({
      "omp-lazy-worker-low": ["@task", "@slow"],
      "omp-lazy-planner": ["@slow"],
    })
    expect(result?.source).toBe("user_override")
  })

  test("schema-invalid file yields invalid_resolution_input with nothing applied", async () => {
    const sandbox = await makeSandbox()
    await makeSandboxWithSchema(sandbox)

    const inputsDir = join(sandbox, ".omo", "inputs")
    await mkdir(inputsDir, { recursive: true })

    // Invalid: wrong schemaVersion
    await writeFile(
      join(inputsDir, "model-chain.v1.json"),
      JSON.stringify({ schemaVersion: 2, overrides: {} }),
    )
    const receipt1 = await readModelChainInput(sandbox)
    expect(receipt1.status).toBe("BLOCKED")
    if (receipt1.status === "BLOCKED") {
      expect(receipt1.code).toBe("invalid_resolution_input")
    }
    expect(toAgentModelOverrides(receipt1)).toBeNull()

    // Invalid: unknown agent name
    await writeFile(
      join(inputsDir, "model-chain.v1.json"),
      JSON.stringify({
        schemaVersion: 1,
        overrides: { "unknown-agent": ["@smol"] },
      }),
    )
    const receipt2 = await readModelChainInput(sandbox)
    expect(receipt2.status).toBe("BLOCKED")
    if (receipt2.status === "BLOCKED") {
      expect(receipt2.code).toBe("invalid_resolution_input")
    }
    expect(toAgentModelOverrides(receipt2)).toBeNull()

    // Invalid: not valid JSON
    await writeFile(join(inputsDir, "model-chain.v1.json"), "not valid json {{{")
    const receipt3 = await readModelChainInput(sandbox)
    expect(receipt3.status).toBe("BLOCKED")
    if (receipt3.status === "BLOCKED") {
      expect(receipt3.code).toBe("invalid_resolution_input")
    }
    expect(toAgentModelOverrides(receipt3)).toBeNull()

    // Invalid: extra properties
    await writeFile(
      join(inputsDir, "model-chain.v1.json"),
      JSON.stringify({
        schemaVersion: 1,
        overrides: { "omp-lazy-worker-low": ["@smol"] },
        extra: "forbidden",
      }),
    )
    const receipt4 = await readModelChainInput(sandbox)
    expect(receipt4.status).toBe("BLOCKED")
    if (receipt4.status === "BLOCKED") {
      expect(receipt4.code).toBe("invalid_resolution_input")
    }
    expect(toAgentModelOverrides(receipt4)).toBeNull()

    // Invalid: empty chain array
    await writeFile(
      join(inputsDir, "model-chain.v1.json"),
      JSON.stringify({
        schemaVersion: 1,
        overrides: { "omp-lazy-worker-low": [] },
      }),
    )
    const receipt5 = await readModelChainInput(sandbox)
    expect(receipt5.status).toBe("BLOCKED")
    if (receipt5.status === "BLOCKED") {
      expect(receipt5.code).toBe("invalid_resolution_input")
    }
    expect(toAgentModelOverrides(receipt5)).toBeNull()

    // Invalid: chain entry with invalid alias
    await writeFile(
      join(inputsDir, "model-chain.v1.json"),
      JSON.stringify({
        schemaVersion: 1,
        overrides: { "omp-lazy-worker-low": ["@turbo"] },
      }),
    )
    const receipt6 = await readModelChainInput(sandbox)
    expect(receipt6.status).toBe("BLOCKED")
    if (receipt6.status === "BLOCKED") {
      expect(receipt6.code).toBe("invalid_resolution_input")
    }
    expect(toAgentModelOverrides(receipt6)).toBeNull()
  })

  test("path outside .omo/inputs is refused with path_outside_inputs", async () => {
    const sandbox = await makeSandbox()
    await makeSandboxWithSchema(sandbox)

    // Try to read a file outside .omo/inputs
    const receipt1 = await readModelChainInput(sandbox, "../etc/passwd")
    expect(receipt1.status).toBe("BLOCKED")
    if (receipt1.status === "BLOCKED") {
      expect(receipt1.code).toBe("path_outside_inputs")
    }

    // Absolute path
    const receipt2 = await readModelChainInput(sandbox, "/etc/passwd")
    expect(receipt2.status).toBe("BLOCKED")
    if (receipt2.status === "BLOCKED") {
      expect(receipt2.code).toBe("path_outside_inputs")
    }

    // Parent traversal from .omo/inputs
    const receipt3 = await readModelChainInput(sandbox, ".omo/inputs/../../secret.json")
    expect(receipt3.status).toBe("BLOCKED")
    if (receipt3.status === "BLOCKED") {
      expect(receipt3.code).toBe("path_outside_inputs")
    }

    // Path within .omo but outside inputs subdirectory
    const receipt4 = await readModelChainInput(sandbox, ".omo/plans/evil.json")
    expect(receipt4.status).toBe("BLOCKED")
    if (receipt4.status === "BLOCKED") {
      expect(receipt4.code).toBe("path_outside_inputs")
    }

    // Windows-style absolute
    const receipt5 = await readModelChainInput(sandbox, "C:\\Users\\secret.json")
    expect(receipt5.status).toBe("BLOCKED")
    if (receipt5.status === "BLOCKED") {
      expect(receipt5.code).toBe("path_outside_inputs")
    }
  })

  test("schema whose sha256 does not match its sidecar is refused with schema_integrity_mismatch", async () => {
    const sandbox = await makeSandbox()
    const schemasDir = join(sandbox, "schemas")
    await mkdir(schemasDir, { recursive: true })

    // Write schema with a wrong sidecar hash
    const schemaContent = JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
    })
    await writeFile(join(schemasDir, "model-chain-input.schema.v1.json"), schemaContent)
    await writeFile(
      join(schemasDir, "model-chain-input.schema.v1.sha256"),
      "0000000000000000000000000000000000000000000000000000000000000000\n",
    )

    // Create a valid input file
    const inputsDir = join(sandbox, ".omo", "inputs")
    await mkdir(inputsDir, { recursive: true })
    await writeFile(
      join(inputsDir, "model-chain.v1.json"),
      JSON.stringify({ schemaVersion: 1, overrides: { "omp-lazy-worker-low": ["@smol"] } }),
    )

    const receipt = await readModelChainInput(sandbox)
    expect(receipt.status).toBe("BLOCKED")
    if (receipt.status === "BLOCKED") {
      expect(receipt.code).toBe("schema_integrity_mismatch")
    }
    expect(toAgentModelOverrides(receipt)).toBeNull()
  })

  test("missing schema file is refused with schema_integrity_mismatch", async () => {
    const sandbox = await makeSandbox()
    // No schemas directory at all

    const inputsDir = join(sandbox, ".omo", "inputs")
    await mkdir(inputsDir, { recursive: true })
    await writeFile(
      join(inputsDir, "model-chain.v1.json"),
      JSON.stringify({ schemaVersion: 1, overrides: {} }),
    )

    const receipt = await readModelChainInput(sandbox)
    expect(receipt.status).toBe("BLOCKED")
    if (receipt.status === "BLOCKED") {
      expect(receipt.code).toBe("schema_integrity_mismatch")
    }
  })

  test("valid override with provider/model format resolves correctly", async () => {
    const sandbox = await makeSandbox()
    await makeSandboxWithSchema(sandbox)

    const inputsDir = join(sandbox, ".omo", "inputs")
    await mkdir(inputsDir, { recursive: true })
    const validInput = {
      schemaVersion: 1,
      overrides: {
        "omp-lazy-worker-high": ["vendor/model-name", "@task"],
      },
    }
    await writeFile(join(inputsDir, "model-chain.v1.json"), JSON.stringify(validInput))

    const receipt = await readModelChainInput(sandbox)
    expect(receipt.status).toBe("PASS")
    if (receipt.status === "PASS") {
      expect(receipt.value.overrides["omp-lazy-worker-high"]).toEqual([
        "vendor/model-name",
        "@task",
      ])
    }
  })

  test("toAgentModelOverrides returns null for both ABSENT and BLOCKED receipts", async () => {
    const absentReceipt: ModelChainInputReceipt = { status: "ABSENT" }
    const blockedReceipt: ModelChainInputReceipt = {
      status: "BLOCKED",
      code: "invalid_resolution_input",
    }

    expect(toAgentModelOverrides(absentReceipt)).toBeNull()
    expect(toAgentModelOverrides(blockedReceipt)).toBeNull()
  })
})
