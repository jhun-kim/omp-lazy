---
name: teammode(omp)
description: Coordinate two or more OMP workers as a bounded asynchronous team with durable identity, acceptance, and cleanup evidence.
---

# Teammode

Use this workflow only for work that has at least two independent, non-overlapping slices.

## Typed kernel commands

Lifecycle transitions execute through trusted coordinator handlers; model text cannot authorize team state changes. The installed runtime exposes `/teammode(omp) prepare|create|status|cancel|archive|delete|resume` as the only authoritative team operations.

## Cost-aware parallelism

Before creating a team, consult the parallelism-history contract in `src/contracts/parallelism-history.ts`. Do not spawn a team when slices overlap or estimated startup cost exceeds serial budget. Explicit teammode may bypass missing parallelism history but never a known nonpositive parallelism estimate.

## Workflow

1. Confirm that the active OMP provider exposes `task` and `hub`. Stop with `async_team_surfaces_unavailable` if either surface is absent.
2. Define two to four uniquely named members by default; explicit justification required for more. Give each member a distinct focus, repository-relative ownership, and concrete deliverable. Reject exact or ancestor/descendant ownership overlap.
3. Initialize the durable team record before dispatch. Reuse an identical record; stop on a conflicting definition.
4. Dispatch all members in one `task` batch with `blocking: false`. Each worker receives a compact task-packet with a tier-appropriate budget. Request isolated worktrees when the provider supports them. Do not replace a missing asynchronous path with synchronous execution and do not claim that inline results form a team.
5. Bind the roster only after the async capability proof confirms task and hub surfaces return actual agent and job identities. Copy actual agent and job IDs from the observed task result; never infer them from requested names. Record a worktree only after repository, cleanliness, and worktree containment validation succeeds.
6. Coordinate through `hub` messaging using bound actual IDs. Poll or cancel only bound job IDs through `hub`. Never interrupt an arbitrary agent.
7. Require each worker to return its strict receipt. The current parent validates every receipt through `omp_lazy_accept_worker_result`; a worker self-report is not acceptance.
8. Mark the team complete only when the parent acceptance ledger has accepted every current member receipt for the current run and attempt.
9. Archive only a completed durable roster. Report that runtime agents were not archived unless the provider returned a specific archive receipt. Delete durable state only after archive.

## Worker tier roles

- `omp-lazy-worker-low`: FAST implementation — one @smol attempt, no reviewer.
- `omp-lazy-worker-medium`: STANDARD repair — @smol then @task, optional reviewer.
- `omp-lazy-worker-high`: DEEP resolution — @smol then @task then @slow, mandatory reviewer.

## Safety

Stop on stale ownership, changed run attempts, incomplete ID mapping, unaccepted results, dirty or unrelated worktrees, or missing cleanup receipts.
