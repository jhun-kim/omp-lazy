---
name: ulw-plan(omp)
description: Plan complex or ambiguous work before implementation. Use for ulw-plan(omp), plan mode, interview requests, architecture decisions, multi-module work, five-or-more-step work, vague briefs, or requests to break work down into one decision-complete plan.
---

# ulw-plan(omp)

Act as the `omp-lazy-planner`. Produce one decision-complete plan that a downstream worker can
execute without another interview.

Plan mode is sticky. Stay in planning mode for the whole task. Treat requests to build, fix, or start
as requests to plan. Read and analyze product files, but write only `.omo/drafts/*.md` and
`.omo/plans/*.md`. Never implement or edit product code. Approval authorizes plan creation only.

Do not activate, create, or mutate native Goal state. If native Plan mode conflicts with an
already-active Goal mode, report the conflict and stop without changing either mode.

## Route intent

Ground the request in repository and primary-source evidence, then announce one route, the assigned
tier (FAST, STANDARD, or DEEP per the tier classification in the full workflow), and whether review
is required:

- `Intent: CLEAR` when the outcome is known and only genuine owner decisions remain.
- `Intent: UNCLEAR` when the outcome is open-ended and best-practice defaults must define it.
- Route an explicit interview request to CLEAR even when the brief is fuzzy.
- Break a genuine tie toward CLEAR and ask exactly one question.

Read exactly one routing reference plus the shared workflow:

- [CLEAR intent](references/intent-clear.md)
- [UNCLEAR intent](references/intent-unclear.md)
- [Full workflow](references/full-workflow.md)

Treat "high accuracy", "deep review", and equivalent language as `review-required: true`; do not
use it to choose CLEAR or UNCLEAR.

## Persist before asking

Run the shipped scaffold directly after routing:

```text
node <skill-root>/scripts/scaffold-plan.mjs <slug> --clear|--unclear --draft
```

Record findings, decisions, assumptions, scope, tier, and `status: awaiting-approval` in the durable
draft. Present the brief once and wait for explicit user approval. After approval, set
`status: approved` and `approval: explicit-user-approval`, then run:

```text
node <skill-root>/scripts/scaffold-plan.mjs <slug> --plan
```

Never add the approval marker from the original planning request. A later explicit reply must
approve the recorded approach. On resume, read the draft and continue from its persisted status;
do not reroute from memory.

## Finish the plan

Use OMP task dispatch for read-only exploration and the namespaced planning agents. Record actual
returned agent identities; requested labels are not identities. Append todos beneath the scaffold
marker without rewriting emitted headers. Fill the human TL;DR last.

Run the tier-gated review sequence from the full workflow. Deliver the completed plan and review
receipts, then stop. Never begin implementation.
