import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import {
  assertExactProductRuntime,
  expectedProductRuntime,
  ProductRuntimeContractError,
  type ProductRuntimeInventory,
} from "../../scripts/product-runtime-contract"
import { repositoryRoot } from "../fixtures/package-test-helpers"

const SURFACE_SIZE_INVARIANTS = [
  {
    field: "agentNames",
    names: expectedProductRuntime.agentNames,
    rationale:
      "the delegation roster is frozen at 11 agents, so tier eligibility and fan-out limits stay exact",
    size: 11,
  },
  {
    field: "skillNames",
    names: expectedProductRuntime.skillNames,
    rationale:
      "the skill set is frozen at 10 directories, so skill sync and the README mirror stay exact",
    size: 10,
  },
  {
    field: "commandNames",
    names: expectedProductRuntime.commandNames,
    rationale:
      "the command surface is frozen at 20 canonical names plus aliases, each registered exactly once",
    size: 20,
  },
  {
    field: "toolNames",
    names: expectedProductRuntime.toolNames,
    rationale: "the runtime owns exactly one tool, omp_lazy_accept_worker_result",
    size: 1,
  },
] as const

const EXPECTED_HANDLER_COUNTS = {
  after_provider_response: 1,
  auto_retry_start: 1,
  before_agent_start: 1,
  context: 1,
  input: 1,
  session_shutdown: 1,
  session_stop: 1,
  tool_call: 2,
  tool_result: 2,
} as const

type InventoryMutation = (inventory: ProductRuntimeInventory) => ProductRuntimeInventory

const DRIFT_CASES: readonly {
  readonly drifted: string
  readonly field: string
  readonly label: string
  readonly mutate: InventoryMutation
}[] = [
  {
    drifted: "omp-lazy-worker-extra",
    field: "agents",
    label: "a twelfth agent",
    mutate: (inventory) => ({
      ...inventory,
      agentNames: [...inventory.agentNames, "omp-lazy-worker-extra"],
    }),
  },
  {
    drifted: "extra-workflow(omp)",
    field: "skills",
    label: "an eleventh skill",
    mutate: (inventory) => ({
      ...inventory,
      skillNames: [...inventory.skillNames, "extra-workflow(omp)"].sort(),
    }),
  },
  {
    drifted: "context",
    field: "handlers",
    label: "a second context handler",
    mutate: (inventory) => ({
      ...inventory,
      handlerCounts: { ...inventory.handlerCounts, context: 2 },
    }),
  },
]

function baselineInventory(): ProductRuntimeInventory {
  return {
    agentNames: [...expectedProductRuntime.agentNames],
    commandNames: [...expectedProductRuntime.commandNames],
    errors: [],
    extensionPaths: [join(repositoryRoot, "src", "index.ts")],
    handlerCounts: { ...expectedProductRuntime.handlerCounts },
    skillNames: [...expectedProductRuntime.skillNames],
    toolNames: [...expectedProductRuntime.toolNames],
    warnings: [],
  }
}

async function captureContractError(
  inventory: ProductRuntimeInventory,
): Promise<ProductRuntimeContractError> {
  const rejection: unknown = await assertExactProductRuntime({ inventory, version: "0.1.0" }).then(
    () => undefined,
    (reason: unknown) => reason,
  )
  if (!(rejection instanceof ProductRuntimeContractError)) {
    throw new Error(`expected ProductRuntimeContractError, received ${String(rejection)}`)
  }
  return rejection
}

describe("registration surface invariance", () => {
  for (const invariant of SURFACE_SIZE_INVARIANTS) {
    it(`keeps ${invariant.field} at ${invariant.size} because ${invariant.rationale}`, () => {
      // Given / Then: the approved inventory is a literal snapshot of the frozen surface size.
      expect(invariant.names.length).toBe(invariant.size)
      expect(new Set(invariant.names).size).toBe(invariant.size)
    })
  }

  it("keeps handlerCounts at the exact nine-slot map because no wave may add an api.on slot", () => {
    // Given / Then: the handler budget is a literal snapshot, not a derived count.
    expect(expectedProductRuntime.handlerCounts).toEqual(EXPECTED_HANDLER_COUNTS)
    expect(Object.keys(expectedProductRuntime.handlerCounts)).toHaveLength(9)
  })

  it("accepts the unmutated approved inventory", async () => {
    // Given: an inventory built from the approved surface with no loader error.
    const inventory = baselineInventory()

    // When / Then: the exact-runtime contract accepts it.
    await expect(assertExactProductRuntime({ inventory, version: "0.1.0" })).resolves.toMatchObject(
      { version: "0.1.0" },
    )
  })

  for (const driftCase of DRIFT_CASES) {
    it(`rejects ${driftCase.label} by naming the ${driftCase.field} field`, async () => {
      // Given: the approved inventory mutated in exactly one field.
      const inventory = driftCase.mutate(baselineInventory())

      // When: the exact-runtime contract compares the mutated inventory.
      const error = await captureContractError(inventory)

      // Then: the drifted field and the drifted value are both named.
      expect(error.name).toBe("ProductRuntimeContractError")
      expect(error.message).toContain(driftCase.field)
      expect(error.message).toContain(driftCase.drifted)
    })
  }

  it("names the highest-precedence drift when agents, skills and handlers drift together", async () => {
    // Given: an inventory carrying a twelfth agent, an extra skill and a second context handler.
    const inventory = DRIFT_CASES.reduce<ProductRuntimeInventory>(
      (current, driftCase) => driftCase.mutate(current),
      baselineInventory(),
    )

    // When: the exact-runtime contract compares the triple-drifted inventory.
    const error = await captureContractError(inventory)

    // Then: handler drift is reported first and the surviving drifts remain on the inventory.
    expect(error.message).toContain("handlers")
    expect(error.message).toContain("context")
    expect(inventory.agentNames).toContain("omp-lazy-worker-extra")
    expect(inventory.skillNames).toContain("extra-workflow(omp)")
  })
})
