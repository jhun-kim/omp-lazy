# Full ulw-plan(omp) workflow

## Contents

- [Role and write boundary](#role-and-write-boundary)
- [Tier classification](#tier-classification)
- [Classify and ground](#classify-and-ground)
- [Durable draft and approval](#durable-draft-and-approval)
- [Generate the plan](#generate-the-plan)
- [Plan template](#plan-template)
- [Evidence packet handoff](#evidence-packet-handoff)
- [Review identities](#review-identities)
- [Legacy normalization](#legacy-normalization)
- [Resume and failure rules](#resume-and-failure-rules)
- [Stop rules](#stop-rules)

## Role and write boundary

Remain the `omp-lazy-planner` for the entire task. Plan only; never implement. Product reads and
read-only analysis are allowed. Writes are limited to `.omo/drafts/*.md` and `.omo/plans/*.md`.
Do not activate, create, or mutate native Goal state.

Plan mode is sticky. A later "do it", "fix it", or "start" message changes planning scope or approves
the brief only when its meaning is explicit; it never authorizes product edits. Approval is not
execution.

## Tier classification

Every plan receives exactly one tier. The tier bounds research depth, review cost, and downstream
execution budgets. Classification is canonical and lives here; other documents reference this
section rather than restating it.

| Tier | Criteria | Review | Interview |
| --- | --- | --- | --- |
| FAST | Outcome fully known, no owner decision, ≤2 components, no boundary risk | One Metis gap pass | None after routing if no owner decision |
| STANDARD | Outcome known with owner decisions, 3-8 components, or unknown boundary tags | One Metis pass; Momus only if explicitly requested or high-risk classified | Owner decisions require explicit approval |
| DEEP | Architecture-scale, >8 components, concrete boundary tags (security, network, privacy, external_write, authorization, containment), or public behavior change | Dual review: fresh Metis + fresh Momus, both must APPROVE independently | Full interview for irreversible choices |

Classification inputs: component count, boundary tags from the compact packet schema
(`src/contracts/task-packet.ts`), public behavior surface, and owner decision presence. When
classification is ambiguous, choose the higher tier.

Tier budgets for downstream execution are defined in `TierBudgets` within the task-packet contract.
The planner records the tier; the executor inherits the matching budget.

## Classify and ground

Ground in repository truth before routing intent. Use the tier classification above to size
research and review cost.

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
tier: FAST|STANDARD|DEEP
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

## Evidence packet handoff

Each plan todo maps to a compact task packet conforming to the schema in
`src/contracts/task-packet.ts`. The packet carries objective, deliverable, allowed paths, boundary
tags, criteria, evidence requirements, tier, and budgets. Downstream execution reads the packet
directly; the plan never re-encodes execution policy.

The planner records the tier in the plan header. The executor compiles the packet with the matching
`TierBudgets` entry. Packet compilation rejects tier-budget mismatches and canonical risk
disagreements.

## Review identities

Mandatory gap analysis and tier-gated review use OMP task dispatch and actual returned identities.
Requested task labels do not prove identity.

### FAST tier

One `omp-lazy-metis` gap analysis pass. No Momus. No second interview when no owner decision exists.
If Metis returns `BLOCKED`, fix cited findings and re-dispatch Metis fresh.

### STANDARD tier

One `omp-lazy-metis` pass is mandatory. Dispatch `omp-lazy-momus` only when the user explicitly
requests high-accuracy review or the work is classified high-risk (concrete boundary tags, public
behavior surface). When Momus runs, both reviewers must return unconditional `APPROVE`.

### DEEP tier

Dispatch one fresh `omp-lazy-metis` and one fresh `omp-lazy-momus` against the same complete plan.
Record distinct actual agent ids, input plan hash, artifact path and hash, verdict, and fixes in the
draft. The two actual ids must differ, and neither lane may reuse the generation-gap identity. Treat
same-reviewer reuse, acknowledgement-only output, missing artifacts, or conditional approval as
`BLOCKED`.

Both reviewers must return unconditional `APPROVE`. Fix every cited blocker, then dispatch both fresh
again against the new complete plan. Never cancel or duplicate a still-running reviewer merely
because it is slow. A review is complete only when the final round has two independent receipts.

## Legacy normalization

Legacy v1 plans (bearing `<!-- omp-lazy-ulw-plan:plan:v1 -->`) normalize byte-preservingly: headings
map to the v2 order, checklist items receive stable `LEGACY-` hash identities, and no content is
dropped or rewritten. Normalization is read-only and produces a `NormalizedPlan` snapshot.

A normalized legacy plan requires one trusted reapproval before execution. The executor must not
treat a byte-preserved normalization receipt as execution authority; the owner must explicitly
approve the normalized plan under the current approval gate.

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
