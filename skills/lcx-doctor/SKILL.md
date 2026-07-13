---
name: lcx-doctor
description: Diagnose OMP and omp-lazy installation or workflow health without mutation. Use for health checks, post-install drift, broken loading, command or skill discovery failures, and compatibility invocations through /omp-lazy-doctor or /lcx-doctor.
---

# Diagnose omp-lazy

Treat `/omp-lazy-doctor` and `/lcx-doctor` as the same `doctor` workflow.

1. Use the offline adapter unless the user separately authorizes network access.
2. Resolve the project root, OMP executable, package manifest, and evidence root from literal arguments. Preserve Windows paths as single argv entries.
3. Capture OMP version, package metadata, declared payload, skill discovery, and loader results. With `--deep`, add a nonrecursive real OMP probe in a disposable profile.
4. Compare only supplied or locally materialized sources. Mark unavailable online freshness checks `NOT_RUN`; never fetch implicitly.
5. Emit PASS, WARN, or FAIL for every check with its captured command or file evidence.
6. Record cleanup and verify the real OMP profile fingerprint is unchanged.

Keep diagnosis read-only. Do not edit config, repair state, install packages, sync sources, create external artifacts, or reuse doctor output as loader proof. Propose a later remediation when mutation is required.
