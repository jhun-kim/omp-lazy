---
name: lcx-contribute-bug-fix
description: Prepare a verified omp-lazy or OMP bug-fix contribution in mandatory offline dry-run mode. Use when asked to fix and contribute a defect through /omp-lazy-contribute-bug-fix or /lcx-contribute-bug-fix.
---

# Prepare a bug-fix contribution

Treat `/omp-lazy-contribute-bug-fix` and `/lcx-contribute-bug-fix` as the same `contribute_bug_fix` workflow. Require `--dry-run <issue-or-bug-ref>`; reject every other V1 form.

1. Confirm ownership from reproduction evidence. Stop when the requested target conflicts with the reproduced owner.
2. Create a fresh disposable workspace under the isolated evidence root. Preserve the user's repository and OMP profile.
3. Reproduce through the real failing surface and capture a RED regression test before production changes.
4. Apply the smallest targeted fix, then capture GREEN from the regression and adjacent suites.
5. Run a real OMP 17.0.5 surface check. Unit-only or mock-only evidence is insufficient.
6. Make an intentional local commit only inside the disposable workspace. Do not push it.
7. Generate the local body with the [PR body helper](scripts/create-pr-body.mjs), passing `--dry-run`, `--input`, and `--output` as literal argv entries.
8. Submit the RED, GREEN, real-surface, commit, body, and cleanup artifacts through `omp_lazy_accept_worker_result`.
9. Remove only resources created by this run. Record cleanup failure and any foreign-state fingerprint change as blocking failures.

V1 performs no clone fetch, issue creation, pull-request creation, comment, label mutation, branch push, or other network write. External delivery requires a separate authorized plan after this dry run succeeds.
