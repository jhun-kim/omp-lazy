# Full ulw-plan(omp) workflow

## Contents

- [Role and write boundary](#role-and-write-boundary)
- [Classify and ground](#classify-and-ground)
- [Durable draft and approval](#durable-draft-and-approval)
- [Generate the plan](#generate-the-plan)
- [Plan template](#plan-template)
- [Review identities](#review-identities)
- [Resume and failure rules](#resume-and-failure-rules)
- [Stop rules](#stop-rules)

## Role and write boundary

Remain the `omp-lazy-planner` for the entire task. Plan only; never implement. Product reads and
read-only analysis are allowed. Writes are limited to `.omo/drafts/*.md` and `.omo/plans/*.md`.
Do not activate, create, or mutate native Goal state.

Plan mode is sticky. A later “do it”, “fix it”, or “start” message changes planning scope or approves
the brief only when its meaning is explicit; it never authorizes product edits. Approval is not
execution.

## Classify and ground

Classify work as trivial, standard, or architecture-scale. Use the classification only to size
research and review cost. Ground in repository truth before routing intent.

For broad work, collect independent evidence lanes, verify claims, turn verified facts into a design,
challenge the design adversarially, and synthesize one plan. Stop research once the clearance check
is answerable or two waves add no useful facts. Treat task results as claims until independently
verified.

Record one to six top-level components in the draft. Record all adopted assumptions with rationale
and reversibility. Keep unrelated dirty files outside scope.

## Durable draft and approval

Create or resume the draft with:

```text
node <skill-root>/scripts/scaffold-plan.mjs <slug> --clear|--unclear --draft
```

The scaffold refuses traversal, symlinked parents or targets, and non-artifact collisions. A plain
repeat is idempotent. `--reset` refuses edits; `--reset --force` resets only a file bearing the
omp-lazy artifact marker and never overwrites an unrelated human file.

Persist these fields before presenting the brief:

```text
status: awaiting-approval
pending-action: write .omo/plans/<slug>.md
approval: pending
```

Present findings, approach, scope, owner decisions or announced defaults, and test strategy once.
Wait for a later explicit reply. The original request to plan is not approval.

Interpret the reply as approval, scope change, or still unclear. For a scope change, update the draft
and brief. For an unclear reply, name the pending action in one line without redoing research.

Only after explicit approval, persist:

```text
status: approved
approval: explicit-user-approval
```

Then run:

```text
node <skill-root>/scripts/scaffold-plan.mjs <slug> --plan
```

The script rejects `--plan` when either durable approval field is missing. This draft is the resume
point after interruption or compaction.

## Generate the plan

After plan creation:

1. Dispatch `omp-lazy-metis` for mandatory gap analysis. Require contradictions, missing constraints,
   scope creep, unsupported assumptions, acceptance gaps, and a concrete verdict artifact.
2. Fold verified findings into the draft and detailed plan.
3. Append todo batches below the scaffold marker. Keep every emitted header byte-for-byte and keep
   the plan append-only outside explicit placeholder replacement.
4. Make the plan decision-complete: exact paths, ownership, dependencies, Must NOT rules, acceptance,
   and exact commands. Leave the executor no hidden interview or judgment call.
5. Give every todo agent-executed happy and failure QA with a contained evidence path. Combine
   implementation and its tests in one todo.
6. Add a final verification wave after all todos. Require plan compliance, code quality, real-surface
   QA, and scope fidelity to approve.
7. Fill the TL;DR last, after details are stable. Confirm the first `##` heading remains
   `## TL;DR (For humans)`.

Target five to eight todos per execution wave. Fewer than three outside the final wave usually means
the work is under-split. One user request produces one plan.

## Plan template

Keep this exact section order:

```text
# <slug> - Work Plan
## TL;DR (For humans)
## Scope
## Verification strategy
## Execution strategy
## Todos
## Final verification wave
## Commit strategy
## Success criteria
```

Fill the TL;DR last. State what the user gets, why the approach is chosen, what is excluded, effort,
risk, and decisions or defaults to inspect.

## Review identities

Mandatory gap analysis and high-accuracy review use OMP task dispatch and actual returned identities.
Requested task labels do not prove identity.

For a high-accuracy round, dispatch one fresh `omp-lazy-metis` and one fresh `omp-lazy-momus` against
the same complete plan. Record distinct actual agent ids, input plan hash, artifact path and hash,
verdict, and fixes in the draft. The two actual ids must differ, and neither lane may reuse the
generation-gap identity. Treat same-reviewer reuse, acknowledgement-only output, missing artifacts,
or conditional approval as `BLOCKED`.

Both reviewers must return unconditional `APPROVE`. Fix every cited blocker, then dispatch both fresh
again against the new complete plan. Never cancel or duplicate a still-running reviewer merely
because it is slow. A review is complete only when the final round has two independent receipts.

CLEAR runs this dual review when requested. UNCLEAR runs it automatically unless classified trivial.

## Resume and failure rules

On resume, read the durable draft first:

- `drafting`: continue grounding and recording decisions.
- `awaiting-approval`: restate only the pending action and wait.
- `approved` with no plan: run `--plan` and continue generation.
- `approved` with a plan: preserve appended content and continue from recorded review receipts.

Fail closed when approval is missing, a target is a symlink or unrelated file, actual reviewer
identities collide, a required artifact is absent, or any action would edit product code. Report the
specific refusal and keep existing artifacts unchanged.

Use `--reset --force` only when the user explicitly requests structural reset of an identified
omp-lazy artifact. Otherwise preserve human and appended content.

## Stop rules

Stop and wait when `status: awaiting-approval` is durable. Stop after the complete plan, required
review receipts, and summary are delivered. Never begin execution, mutate native Goal state, or turn
planning approval into implementation authority.
