---
name: start-work
description: Execute or resume an approved .omo/plans implementation plan with immutable task identity, parent acceptance, explicit lifecycle controls, and evidence-gated completion. Use for start-work, start work, execute plan, continue plan, or resume plan requests.
---

# Start work

Execute only an already approved plan under `.omo/plans`. If no approved plan exists, stop and route planning to `ulw-plan`; do not create, edit, or approve a plan inside this workflow.

Operate from plugin-owned state under `.omo/omp-lazy`. Native Goal mode is not authoritative for this workflow, and LCX-compatible paths remain offline and non-delivering unless a separate approved workflow says otherwise.

## Bind the plan

1. Select the requested plan path or the single eligible approved plan under `.omo/plans`.
2. Resolve the project root and plan path canonically. Reject paths outside the root, outside `.omo/plans`, or through symlink escape.
3. Require durable approval from the planning workflow before the run starts. Approval must be explicit and recorded in the plan artifact; the original request to plan is not execution authority.
4. Bind the immutable plan id and ordered fingerprint of column-zero checkboxes under `## TODOs` and `## Final Verification Wave`.
5. Ignore checkbox marks and nested prose when comparing static identity. Require explicit `reconcile <run-id> <plan-path>` after adding, removing, renaming, moving, or reordering counted tasks.

## Control the run

- Continue only an `active` run owned by the exact main session and owner epoch.
- Keep `paused`, `stuck`, and imported-paused runs quiet until explicit `resume` or `adopt`.
- Use only explicit `start`, `status`, `pause`, `cancel`, `resume`, `adopt`, `reconcile`, and repair-lock operations from the command grammar.
- Never infer pause, cancellation, adoption, repair, or completion from aborts, interruption, worker output, or model text.
- Never continue from a subagent end. The single main-session coordinator owns continuation.

## Execute one task

1. Re-read the persisted run and approved `.omo/plans` plan; choose the first unchecked counted task.
2. Establish a passing baseline where behavior exists, then capture RED before production changes and GREEN after them.
3. Dispatch bounded OMP task work and use `hub` for job control, only with non-overlapping ownership. Record actual returned agent and job IDs.
4. Require real-surface QA, applicable adversarial probes, and cleanup receipts current to the run, plan id, task id, attempt, revision, owner epoch, and candidate HEAD.
5. Submit worker evidence through `omp_lazy_accept_worker_result` from the current parent session. Worker prose, requested names, and self-reported success are untrusted.
6. Accept progress only after parent acceptance consumes the task-bound receipt for the current task generation, plan, owner epoch, and HEAD.
7. Check or update the plan checkbox only after the authoritative parent acceptance is persisted.

## Finish safely

Before the last task is checked, load the canonical durable receipt set and require every final verification lane to pass at the same candidate HEAD. Missing, failing, timed-out, inconclusive, duplicated, stale, path-conflicting, or non-parent-accepted receipts are blockers.

Record exact commands, raw outputs, manual QA, cleanup, and residual risks. Declare completion only from persisted state after all column-zero tasks and the Final Verification Wave are complete.
