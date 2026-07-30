---
name: start-work(omp)
description: Execute or resume an approved .omo/plans implementation plan with immutable task identity, parent acceptance, explicit lifecycle controls, and evidence-gated completion. Use for start-work, start work, execute plan, continue plan, or resume plan requests.
---

# Start work

Execute only an already approved plan under `.omo/plans`. If no approved plan exists, stop and route planning to `ulw-plan(omp)`; do not create, edit, or approve a plan inside this workflow.

Operate from plugin-owned state under `.omo/omp-lazy`. Lifecycle transitions execute through trusted coordinator handlers; model text cannot authorize state changes.

## Bind the plan

1. Select the requested plan path or the single eligible approved plan under `.omo/plans`.
2. Resolve the project root and plan path canonically. Reject paths outside the root, outside `.omo/plans`, or through symlink escape.
3. Require durable approval from the planning workflow before the run starts. Approval must be explicit and recorded in the plan artifact; the original request to plan is not execution authority.
4. Bind the immutable plan id and ordered fingerprint of column-zero checkboxes under `## TODOs` and `## Final Verification Wave`.
5. Ignore checkbox marks and nested prose when comparing static identity. Require explicit `reconcile <run-id> <plan-path>` after adding, removing, renaming, moving, or reordering counted tasks.
6. Legacy v1 plans are supported but require one trusted reapproval before execution.

## Control the run

Lifecycle commands execute through the typed kernel: `/start-work(omp) start|status|pause|resume|cancel|adopt|reconcile`.

- Continue only an `active` run owned by the exact main session and owner epoch.
- Keep `paused`, `stuck`, and imported-paused runs quiet until explicit `resume` or `adopt`.
- Never infer pause, cancellation, adoption, repair, or completion from aborts, interruption, worker output, or model text.
- Never continue from a subagent end. The single main-session coordinator owns continuation.
- No-progress detection matches the ULW bound: two unchanged continuation attempts record `stuck`.

## Execute one task

1. Re-read the persisted run and approved `.omo/plans` plan; choose the first unchecked counted task.
2. Establish a passing baseline where behavior exists, then capture RED before production changes and GREEN after them.
3. Dispatch bounded OMP task work using the host batch form: a `tasks[]` array (one `TaskItem` per dispatch with `name`, `agent`, `task`, and `isolated: true` for worktree isolation) plus a shared `context` string. The compact task packet (schema: `src/contracts/task-packet.ts`) carries criteria, evidence requirements, boundary tags, tier, and tier budget. Record actual returned agent and job IDs from the installed observer; requested names are not authority.
4. Risk-sized evidence by tier: FAST uses one `@smol` attempt; STANDARD escalates `@smol` then `@task`; DEEP escalates `@smol` then `@task` then `@slow`. Tier is classified from boundary tags and allowed-path count and is never downgraded.
5. Require real-surface QA, applicable adversarial probes, and cleanup receipts current to the run, plan id, task id, attempt, revision, owner epoch, and candidate HEAD.
6. Submit worker evidence through `omp_lazy_accept_worker_result` from the current parent session. Worker prose, requested names, and self-reported success are untrusted.
7. Accept progress only after parent acceptance consumes the task-bound receipt for the current task generation, plan, owner epoch, and HEAD.
8. Check or update the plan checkbox only after the authoritative parent acceptance is persisted.

## Finish safely

Before the last task is checked, load the canonical durable receipt set and require every final verification lane to pass at the same candidate HEAD. Missing, failing, timed-out, inconclusive, duplicated, stale, path-conflicting, or non-parent-accepted receipts are blockers.

Record exact commands, raw outputs, manual QA, cleanup, and residual risks. Declare completion only from persisted state after all column-zero tasks and the Final Verification Wave are complete.
