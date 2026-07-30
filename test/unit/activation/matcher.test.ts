import { describe, expect, test } from "bun:test"
import { matchActivation } from "../../../src/activation/matcher"
import { COMMAND_REGISTRATIONS } from "../../../src/commands/command-definitions"

describe("matchActivation – baseline characterization", () => {
  test("matches every registered command name in isolation", () => {
    for (const reg of COMMAND_REGISTRATIONS) {
      const result = matchActivation(reg.command)
      expect(result).not.toBeNull()
      expect(result?.workflow).toBe(reg.workflow)
      expect(result?.command).toBe(reg.command)
    }
  })

  test("matches a command embedded in surrounding text", () => {
    const result = matchActivation("please use ultrawork(omp) now")
    expect(result).not.toBeNull()
    expect(result?.workflow).toBe("ultrawork")
  })

  test("returns null for text with no command name", () => {
    expect(matchActivation("just a regular message")).toBeNull()
  })

  test("returns null for ambiguous text naming multiple workflows", () => {
    expect(matchActivation("use ulw(omp) and ulw-loop(omp)")).toBeNull()
  })

  test("returns null for near-miss boundary cases", () => {
    expect(matchActivation("bulwark")).toBeNull()
    expect(matchActivation("ulw_plan")).toBeNull()
    expect(matchActivation("ulw-plan(omp).md")).toBeNull()
    expect(matchActivation("dir/ulw-loop(omp)")).toBeNull()
  })

  test("returns a match for command name without leading slash", () => {
    const result = matchActivation("use ulw-plan(omp) please")
    expect(result).not.toBeNull()
    expect(result?.workflow).toBe("ulw_plan")
  })
})

describe("matchActivation – whole-token trigger allowlist (todo 10)", () => {
  describe("positive cases: should activate", () => {
    test.each([
      ["ultrawork this", "ultrawork"],
      ["ULW", "ultrawork"],
      ["ulw", "ultrawork"],
      ["Ultrawork heavy mode", "ultrawork"],
      ["please run ulw now", "ultrawork"],
      ["omp-lazy-ultrawork(omp)", "ultrawork"],
      ["omp-lazy-ulw-plan(omp)", "ulw_plan"],
      ["start-work(omp)", "start_work"],
      ["teammode(omp)", "teammode"],
    ] as const)("'%s' activates workflow %s", (input, expectedWorkflow) => {
      const result = matchActivation(input)
      expect(result).not.toBeNull()
      expect(result?.workflow).toBe(expectedWorkflow)
    })
  })

  describe("negative cases: must NOT activate", () => {
    test.each([
      ["ulwrapper", "substring prefix"],
      ["bulwark", "substring embedded"],
      ["multiulw", "substring suffix"],
      ["```\nulw\n```", "fenced code block"],
      ["```bash\nultrawork\n```", "fenced code block with lang"],
      ['"path/to/ulw"', "double-quoted path"],
      ["'path/to/ulw'", "single-quoted path"],
      ["`path/to/ulw`", "backtick-quoted path"],
    ] as const)("'%s' does not activate (%s)", (input, _reason) => {
      const result = matchActivation(input)
      expect(result).toBeNull()
    })
  })
})
