---
name: teammode(omp)
description: Coordinate two or more OMP workers as a bounded asynchronous team with durable identity, acceptance, and cleanup evidence.
---

# Teammode

Use this workflow only for work that has at least two independent, non-overlapping slices.

1. Confirm that the active OMP provider exposes `task` and `hub`. Stop with `async_team_surfaces_unavailable` if either surface is absent.
2. Define two to eight uniquely named members. Give each member a distinct focus, repository-relative ownership, and concrete deliverable. Reject exact or ancestor/descendant ownership overlap.
3. Initialize the durable team record before dispatch. Reuse an identical record; stop on a conflicting definition.
4. Dispatch all members in one `task` batch with `blocking: false`. Request isolated worktrees when the provider supports them. Do not replace a missing asynchronous path with synchronous execution and do not claim that inline results form a team.
5. Bind the roster only after Todo8 proves asynchronous capability. Copy actual agent and job IDs from the observed task result; never infer them from requested names. Record a worktree only after repository, cleanliness, and worktree containment validation succeeds.
6. Coordinate through `hub` messaging using bound actual IDs. Poll or cancel only bound job IDs through `hub`. Never interrupt an arbitrary agent.
7. Require each worker to return its strict receipt. The current parent validates every receipt through `omp_lazy_accept_worker_result`; a worker self-report is not acceptance.
8. Mark the team complete only when Todo9 has accepted every current member for the current run and attempt.
9. Archive only a completed durable roster. Report that runtime agents were not archived unless the provider returned a specific archive receipt. Delete durable state only after archive.

Stop on stale ownership, changed run attempts, incomplete ID mapping, unaccepted results, dirty or unrelated worktrees, or missing cleanup receipts.
