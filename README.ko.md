# omp-lazy

[English](README.md) | 한국어

`omp-lazy`는 OMP 17.x용 MIT 라이선스 기반 소스 전용 TypeScript 확장입니다. 소스는 이 공개
저장소에서 관리되며, `package.json#private` 설정이 실수로 패키지 레지스트리에 게시되는 것을
막습니다. 이 확장은 Bun에서 `package.json#omp.extensions`를 통해 로드되며 다른 호스트 설치를
찾거나 다운로드하거나 가져오지 않습니다.

## OMP에 추가되는 기능

- `/ulw-plan(omp)`과 `/start-work(omp)`를 통한 지속 가능한 계획 수립 및 실행.
- `/teammode(omp)`를 통한 capability 검증 기반 multi-agent 조정.
- `/ulw-loop(omp)`와 `/ultrawork(omp)`를 통한 경계가 정해진 자율 workflow.
- `/ulw-research(omp)`를 통한 증거 중심 조사.
- 로컬에서만 동작하며 전달하지 않는 LazyCodex 진단 및 contribution 초안.
- repository 범위 state, 변경 불가능한 worker identity binding, parent acceptance, release-grade
  verification gate.

## 요구 사항

- Bun 1.3.14와 커밋된 `bun.lock`.
- Git. candidate와 evidence provenance가 깨끗한 tracked worktree 및 `HEAD`에 묶이기 때문입니다.
- OMP 17.x. 개발 및 host verification은 OMP 17.0.5에 고정되어 있으며, 다른 major version은
  plugin 또는 profile 작업 전에 거부됩니다.
- 이 저장소의 source checkout.
- Windows link-path coverage를 위한 Windows Developer Mode 또는 동등한 symlink 권한.

registry credential, publishing token, API secret, network-write 권한은 필요하지 않습니다.
결정적 host preflight는 loopback provider와 secret이 아닌 fixture key를 사용합니다.

## 소스 설치

저장소 root에서 locked dependency만 설치합니다.

```sh
bun install --frozen-lockfile
```

operator가 관리하는 source link의 경우, checkout에서 고정된 OMP 17.x executable을 실행합니다.

```sh
omp plugin link . --json
omp plugin list --json
omp plugin doctor --json
```

이 link가 곧 설치입니다. npm 설치나 공개 tarball 경로는 없습니다. release gate는 disposable profile을
사용합니다. 따라서 위 command들은 operator가 선택한 OMP profile에 의도적으로 영향을 주므로,
해당 private link가 필요할 때만 실행해야 합니다.

## 로컬 검증

빠른 developer gate는 의도적으로 typecheck, lint, unit, contract, integration coverage로만
제한됩니다.

```sh
bun run check
```

권위 있는 release gate는 모든 fast gate를 실행한 뒤 skill sync, README contract,
source loader/discovery, committed candidate packing, ordinary-directory staged smoke, hostile
G01-G25 replay, pinned host preflight, platform host gate를 실행합니다. Windows는 link/list/doctor
coverage를 실행합니다. Linux와 기타 POSIX host는 profile fingerprint verification이 포함된 pinned dogfood를
실행합니다. 모든 subgate는 필수이며, 비어 있거나 non-PASS인 structured evidence는 release를 실패시킵니다.

```sh
bun run verify:release
```

release CLI는 전체 structured receipt를 내부에서 검증하지만 외부에는 gate별 PASS 요약만
출력합니다. host profile 경로, sandbox root, profile fingerprint는 공개 CI 로그에 기록하지
않습니다.

`pack:candidate`, `smoke:staged`, evidence manifest에는 committed byte가 필요합니다. release와
manifest generation은 clean tracked worktree에서만 실행하세요. 생성된 tarball과 receipt는 ignored local artifact로
남습니다.

## Verification matrix

| Surface | Fast `check` | `verify:release` | Windows CI | Linux CI |
| --- | --- | --- | --- | --- |
| Type, lint, unit, contract, integration | Yes | Yes | Yes | Yes |
| Skill sync and README contract | No | Yes | Yes | Yes |
| Source loader and discovery | No | Yes | Yes | Yes |
| Committed candidate pack and staged install | No | Yes | Yes | Yes |
| Hostile G01-G25 replay | No | Yes | Yes | Yes |
| Pinned OMP 17.0.5 preflight | No | Yes | Yes | Yes |
| OMP link/list/doctor path | No | Windows | Yes | Through dogfood |
| Pinned OMP dogfood/profile fingerprint | No | POSIX | No | Yes |
| Publish or registry upload | No | No | No | No |

## Harness evaluation

harness evaluator(`harness-eval/`)는 frozen closure입니다. evidence를 산출하는 동안 해당 byte와
corpus manifest는 편집되지 않습니다. evaluation은 세 가지 mode로 실행됩니다.

- **Deterministic.** `bun run eval:harness:deterministic`은 registry credential, network write, live model
  access 없이 synthetic target을 상대로 corpus를 실행합니다. fixture, oracle, adapter contract를 검증하며,
  fast gate와 release gate가 요구하는 유일한 harness mode입니다. deterministic `PASS`는 corpus contract가
  성립함을 증명하며, live quality 결과가 아닙니다.
- **Baseline.** `bun run eval:harness:baseline`은 고정된 pre-redesign defect set을 다시 실행해 regression을
  보이게 유지합니다.
- **Live.** `bun run eval:harness:live`는 credentialed paired profile을 실행합니다. secret이 아닌 operator
  input `.omo/inputs/harness-live-profile.v1.json`이 필요하며, model call 전에 고정된 schema로 검증됩니다.
  secret key는 environment 전용으로 유지되며 이 file에서 읽지 않습니다.

live input이 없거나 schema가 유효하지 않으면 synthetic `PASS`가 아니라 `BLOCKED: live_profile_input_missing`
(또는 `live_profile_input_schema_invalid`)입니다. `bun run verify:harness`는 고정된 receipt를 검증하며
deterministic `PASS`와 live `PASS` 또는 `BLOCKED` 결과를 구별합니다. quality 및 cost ratio는 live 비교가 실제로
측정되었을 때만 보고됩니다. 어떤 release surface도 관찰되지 않은 10% cost 또는 95% quality 수치를 광고하지
않습니다. auditor 또는 live credential이 없으면 final approval은 `BLOCKED`로 남으며, `BLOCKED` 결과는 최종입니다.
즉 approval로 주장할 수 없습니다.

## Package scripts

alias와 expansion 열은 `package.json#scripts`를 machine check로 정확히 반영한 mirror입니다.

| Alias | Expansion | Purpose |
| --- | --- | --- |
| `typecheck` | `bun scripts/run-isolated.ts --timeout-ms 300000 --cwd . --env-profile unit -- bun scripts/run-local-tsc.ts --noEmit` | 고정된 로컬 TypeScript check. |
| `lint` | `bun scripts/run-isolated.ts --timeout-ms 120000 --cwd . --env-profile unit -- bunx biome check .` | Biome lint 및 formatting check. |
| `test:unit` | `bun scripts/run-isolated.ts --timeout-ms 120000 --cwd . --env-profile unit -- bun test test/unit` | Unit suite. |
| `test:contract` | `bun scripts/run-isolated.ts --timeout-ms 240000 --cwd . --env-profile unit -- bun test --timeout 30000 test/contract` | Product 및 boundary contract. |
| `test:integration:core` | `bun scripts/run-isolated.ts --timeout-ms 300000 --cwd . --env-profile integration -- bun test test/integration` | Core integration suite. |
| `test:integration:capability` | `bun scripts/run-isolated.ts --timeout-ms 300000 --cwd . --env-profile omp -- bun test test/host-integration` | Isolated real-OMP capability suite. |
| `test:integration` | `bun scripts/run-integration.ts` | Serial core and real-OMP capability suites. |
| `test:hostile` | `bun scripts/run-isolated.ts --timeout-ms 900000 --cwd . --env-profile integration -- bun scripts/replay-hostile.ts` | 경계가 정해진 hostile G01-G25 replay. |
| `test:regression` | `bun scripts/run-isolated.ts --timeout-ms 120000 --cwd . --env-profile unit -- bun test test/contract/regression.test.ts` | 집중 regression suite. |
| `preflight:omp` | `bun scripts/run-isolated.ts --timeout-ms 300000 --cwd . --env-profile omp -- bun scripts/preflight-real-omp.ts` | 고정된 host 및 async preflight. |
| `smoke:loader` | `bun scripts/run-isolated.ts --timeout-ms 300000 --cwd . --env-profile integration -- bun scripts/probe-loader.ts` | Source entrypoint inventory. |
| `smoke:discovery` | `bun scripts/run-isolated.ts --timeout-ms 300000 --cwd . --env-profile integration -- bun scripts/probe-discovery.ts` | Source skill 및 agent discovery. |
| `pack:candidate` | `bun scripts/run-isolated.ts --timeout-ms 900000 --cwd . --env-profile integration -- bun scripts/pack-candidate.ts` | 깨끗하게 commit된 byte pack. |
| `smoke:link:windows` | `bun scripts/run-isolated.ts --timeout-ms 900000 --cwd . --env-profile omp -- bun scripts/smoke-link-windows.ts` | Windows link/list/doctor path. |
| `smoke:staged` | `bun scripts/run-isolated.ts --timeout-ms 900000 --cwd . --env-profile integration -- bun scripts/smoke-staged.ts` | Ordinary-directory tarball install. |
| `dogfood:omp` | `bun scripts/run-isolated.ts --timeout-ms 600000 --cwd . --env-profile omp -- bun scripts/smoke-real-omp.ts` | 고정된 real-host dogfood. |
| `verify:candidate` | `bun scripts/run-isolated.ts --timeout-ms 1200000 --cwd . --env-profile integration -- bun scripts/verify-candidate.ts` | 명시적 hostile evidence bundle 검증. |
| `verify:skills` | `bun scripts/run-isolated.ts --timeout-ms 120000 --cwd . --env-profile unit -- bun scripts/assert-skill-sync.ts` | 정확한 command-to-skill sync. |
| `verify:readme` | `bun scripts/run-isolated.ts --timeout-ms 120000 --cwd . --env-profile unit -- bun scripts/verify-readme-contract.ts` | README/package/runtime contract. |
| `evidence:source` | `bun scripts/build-evidence-manifest.ts --mode source --root .omo/evidence/plugin-completion-60 --commit-from-git-head` | T01-T15 evidence를 clean `HEAD`에 binding. |
| `evidence:review` | `bun scripts/build-evidence-manifest.ts --mode review --root .omo/evidence/plugin-completion-60 --commit-from-git-head` | source 및 F1-F4 receipt binding. |
| `eval:harness:deterministic` | `bun scripts/run-isolated.ts --timeout-ms 900000 --cwd . --env-profile integration -- bun harness-eval/src/cli.ts run --mode deterministic --manifest harness-eval/manifest.v1.json --validate-corpus --synthetic-target harness-eval/fixtures/synthetic-target` | 결정적 harness corpus를 실행합니다. |
| `eval:harness:baseline` | `bun scripts/run-isolated.ts --timeout-ms 900000 --cwd . --env-profile integration -- bun harness-eval/src/cli.ts run --mode baseline` | 고정된 baseline harness defect를 실행합니다. |
| `eval:harness:live` | `bun scripts/run-isolated.ts --timeout-ms 7200000 --cwd . --env-profile omp -- bun harness-eval/src/cli.ts run --mode live` | credentialed live harness evaluation을 실행합니다. |
| `verify:harness` | `bun scripts/run-isolated.ts --timeout-ms 900000 --cwd . --env-profile integration -- bun harness-eval/src/cli.ts verify` | 고정된 harness receipt를 검증합니다. |
| `evidence:harness:source` | `bun scripts/run-isolated.ts --timeout-ms 900000 --cwd . --env-profile integration -- bun harness-eval/src/cli.ts evidence --mode source` | harness source evidence manifest를 생성합니다. |
| `evidence:harness:review` | `bun scripts/run-isolated.ts --timeout-ms 900000 --cwd . --env-profile integration -- bun harness-eval/src/cli.ts evidence --mode review` | harness review evidence manifest를 생성합니다. |
| `check` | `bun scripts/check.ts` | 빠른 local gate. |
| `verify:release` | `bun scripts/verify-release.ts` | 권위 있는 platform release gate. |

`verify:candidate`는 제공된 hostile bundle을 조사할 때 package-script separator 뒤에
`--bundle <verdict.json>`를 받습니다. 이는 live `verify:release`의 대체 수단이 아닙니다.

## Runtime behavior

| Behavior | Description |
| --- | --- |
| `directive_activation` | allowlist에 있는 trigger token이 user prompt에 포함되면 해당 workflow directive가 hidden injected message로 활성화되며, user의 원본 text는 byte 단위로 동일하게 유지됩니다. |
| `idle_continuation` | 활성 start-work plan 또는 ulw-loop goal이 agent idle 시 bounded, persisted counter 아래에서 자체적으로 continuation하며, prompt를 재작성하지 않고 steering reminder를 사용합니다. |
| `delegation_model_chains` | 각 agent가 ordered model chain과 thinkingLevel을 선언하며, chain fallback이 순서대로 시도되고 per-attempt provenance가 기록되며, blocked spawn은 corrective reason을 반환합니다. |
| `status_line` | OMP status line과 working message가 활성 workflow, run, progress, model role을 표시하며, UI가 없을 때 silent하게 degradation됩니다. |
| `rules_injection` | repository 범위 .omo/rules/*.md glob 매칭 rule과 truncation-safe directive/skill catalog가 명시적 byte budget 아래 deterministic priority로 조립됩니다. |

## Product commands

canonical name과 alias는 모두 정확히 한 번씩 등록됩니다.

| Command | Workflow |
| --- | --- |
| `/lcx-contribute-bug-fix(omp)` | Offline dry-run contribution workflow. |
| `/lcx-doctor(omp)` | Read-only health diagnosis. |
| `/lcx-report-bug(omp)` | Local report draft. |
| `/omp-lazy-contribute-bug-fix(omp)` | Canonical contribution command. |
| `/omp-lazy-doctor(omp)` | Canonical doctor command. |
| `/omp-lazy-report-bug(omp)` | Canonical report command. |
| `/omp-lazy-start-work(omp)` | Canonical plan execution command. |
| `/omp-lazy-teammode(omp)` | Canonical durable team command. |
| `/omp-lazy-ultrawork(omp)` | Canonical ultrawork command. |
| `/omp-lazy-ulw-deliver(omp)` | Canonical full-lifecycle delivery command. |
| `/omp-lazy-ulw-plan(omp)` | Canonical planning command. |
| `/omp-lazy-ulw-research(omp)` | Canonical research command. |
| `/start-work(omp)` | Plan execution alias. |
| `/teammode(omp)` | Durable team alias. |
| `/ultrawork(omp)` | Ultrawork alias. |
| `/ulw(omp)` | Short ultrawork alias. |
| `/ulw-deliver(omp)` | Full-lifecycle delivery alias. |
| `/ulw-loop(omp)` | Bounded loop command. |
| `/ulw-plan(omp)` | Planning alias. |
| `/ulw-research(omp)` | Research alias. |

## Skills

| Skill | Purpose |
| --- | --- |
| `lcx-contribute-bug-fix(omp)` | 로컬 dry-run contribution proposal을 작성합니다. |
| `lcx-doctor(omp)` | 로컬 LazyCodex 및 OMP 상태를 read-only로 진단합니다. |
| `lcx-report-bug(omp)` | 제한된 로컬 bug-report draft를 작성합니다. |
| `start-work(omp)` | 승인된 `.omo/plans`를 evidence 및 parent acceptance와 함께 실행합니다. |
| `teammode(omp)` | capability가 입증되고 겹치지 않는 durable team을 조정합니다. |
| `ultrawork(omp)` | 엄격하고 경계가 정해진 실행을 진행합니다. |
| `ulw-deliver(omp)` | Plan, Implement, Verify, QA를 순차적으로 오케스트레이션합니다. |
| `ulw-loop(omp)` | 경계가 정해진 goal-independent workflow를 반복합니다. |
| `ulw-plan(omp)` | 실행 전에 decision-complete plan을 만듭니다. |
| `ulw-research(omp)` | retained attribution과 함께 증거 중심 research를 실행합니다. |

## Agents

| Agent | Role |
| --- | --- |
| `omp-lazy-explorer` | Repository exploration. |
| `omp-lazy-librarian` | External documentation and source research. |
| `omp-lazy-metis` | Planning ambiguity analysis. |
| `omp-lazy-momus` | Plan critique. |
| `omp-lazy-planner` | Decision-complete planning. |
| `omp-lazy-qa` | Product-surface verification. |
| `omp-lazy-researcher` | Saturated research. |
| `omp-lazy-reviewer` | Parent acceptance review. |
| `omp-lazy-worker-high` | High-complexity execution. |
| `omp-lazy-worker-low` | Low-complexity execution. |
| `omp-lazy-worker-medium` | Medium-complexity execution. |

runtime은 `omp_lazy_accept_worker_result` tool 하나와 `input`, `before_agent_start`,
`session_stop`, `tool_call`, `tool_result` 각각에 대한 handler 하나도 등록합니다.

## Durable state

repository state는 `<repository>/.omo/omp-lazy` 아래에만 저장됩니다. run, event, active index,
lock, recovery file은 repository 범위로 유지됩니다. canonical path check는 mutation 전에 symlink 또는 Windows
junction escape를 거부합니다. release 및 host gate는 disposable home, profile, temporary directory,
worktree root를 사용합니다. 기존 operator profile 또는 state root는 변경하지 않습니다. 이 check들은 각
operation boundary에서 static redirected path를 거부합니다. 다만 Bun이 portable `openat` style relative filesystem API를
노출하지 않으므로, 별도의 hostile OS process가 filesystem topology를 동시에 바꾸는 상황까지 보호한다고 주장하지는 않습니다.

Windows에서 capability-probe receipt는 direct launcher exit와 해당 provider 및 sandbox cleanup을 증명합니다.
launcher가 종료된 뒤 arbitrary descendant를 containment한다고 증명하지는 않습니다. 이를 위해서는 pinned host
runtime이 노출하지 않는 Windows Job Object 사전 등록이 필요합니다. Cooperative child cleanup은 기존 bounded test로
계속 검증됩니다.

## Migration

durable state record는 명시적 `schemaVersion`을 가집니다. lifecycle store는 mutation 전에 repository lock
아래에서 first access 시 legacy v1 record를 v2로 자동 migration합니다.

- **자동 v1→v2 migration.** legacy state root에 처음 access하면 active, run, event, team, task-fact,
  acceptance, WAL, rejection record 전부가 하나의 journaled transaction으로 schema v1에서 v2로 변환됩니다.
  이미 current인 root에 다시 실행하면 no-op입니다.
- **실패 시 rollback.** migration은 각 단계를 journal에 기록하고 먼저 원본 v1 byte를 backup합니다. 어떤
  publication 단계에서든 crash 또는 검증 실패가 발생하면 완전한 v1 set을 복원하며, store는 부분적으로
  migration된 혼합 상태를 남기지 않습니다.
- **알 수 없는 version 거부.** 미래 또는 알 수 없는 `schemaVersion`의 record는 추측하지 않고
  `unknown_schema_version`으로 거부됩니다. 손상된 backup이나 모호한 record identity는
  `migration_recovery_required`로 fail closed됩니다.
- **legacy plan은 reapproval 필요.** v1 plan을 v2 view로 정규화해도 해당 text approval은 migration되지
  않습니다. legacy plan은 실행 전에 한 번의 trusted reapproval이 필요합니다. 과거 v1 event는 audit 전용으로
  남으며 v2 work를 settle할 수 없습니다.

## Evidence handoff

`.omo/evidence/**`는 ignored 상태이며 절대 tracked되어서는 안 됩니다. source evidence root는 정확한
T01-T15 receipt set, 명시적 T14 G01-G25 sidecar, 그리고 T14 aggregate 및 rejection receipt가 참조하는 raw file만
포함합니다. builder는 누락, 초과, 비어 있음, symlink, escape, 변경, non-regular file을 거부하며 canonical sorted
SHA-256 entry를 씁니다.

T15 commit이 `HEAD`이고 tracked file이 clean이면 source manifest를 생성합니다.

```sh
bun run evidence:source
```

`.omo/evidence/plugin-completion-60/final/evidence-manifest.json`에 출력된 canonical absolute path를 독립적인
F1-F4 reviewer에게 전달합니다. 각 reviewer는 manifest 옆에 자신의 named receipt를 쓰기 전에 source hash를
검증합니다. 정확히 네 개의 무조건 `APPROVE` review와 필수 F2 release log가 변경되지 않은 commit에 존재하면
review manifest를 생성합니다.

```sh
bun run evidence:review
```

review builder는 모든 source hash를 다시 검증하고, 정확한 final-wave file을 요구하며, 해당 hash와
source-manifest hash를 같은 Git `HEAD`에 binding합니다. coordinator integration은 commit SHA를 바꾸므로,
coordinator는 integration 이후 F1-F4를 dispatch하기 전에 `bun run evidence:source`를 다시 실행해야 합니다.

## Offline LCX limits

LCX report 및 contribution workflow는 로컬 전용이며 전달하지 않습니다. `lcx-report-bug(omp)`는
`externalWrite: not_run`을 기록합니다. `lcx-contribute-bug-fix(omp)`는 `--dry-run`을 요구합니다. 이 workflow들은 issue,
pull request, push, release, upload 또는 기타 network write를 만들지 않습니다. `lcx-doctor(omp)`는 read-only입니다.
operator는 생성된 draft를 이 plugin 밖에서 별도로 검토하고 전달해야 합니다.

## Troubleshooting

- `unsupported_host_version`: OMP 17.x로 update하세요. release verification은 17.0.5에 고정되어 있습니다. OMP가
  update되면 exact development pin도 함께 update하고 `bun run verify:release`를 다시 실행하세요.
- `missing_executable`: `bun install --frozen-lockfile`을 실행하고 정확한 로컬 OMP 17.0.5
  development dependency가 있는지 확인하세요. 또는 조사할 때 underlying host diagnostic에만 literal executable을
  전달하세요.
- Windows symlink failure: Developer Mode를 enable하거나 elevated environment를 사용한 뒤,
  `bun run preflight:omp`와 `bun run smoke:link:windows`를 다시 실행하세요.
- Candidate worktree changed after packaging: 의도한 tracked change를 commit하고, 의도하지 않은
  tracked change를 제거한 뒤 candidate packing과 staged smoke를 다시 실행하세요. 오래된 tarball은 절대 재사용하지 마세요.
- Missing or empty staged/hostile evidence: 소유 live gate를 다시 실행하세요. placeholder
  receipt를 만들거나 누락된 subgate를 soft pass로 낮추지 마세요.
- Evidence manifest extra-file failure: 실험에는 복사한 evidence root를 사용하고 canonical root는 exhaustive하게
  유지하세요. required receipt가 아니라 선언되지 않은 copied artifact만 제거하세요.

## Source and attribution

workflow concept와 일부 skill asset은 MIT License에 따라 commit
`f39306f1adab6ff155fd736cc7376d27156472bc`의
[LazyCodex](https://github.com/code-yeongyu/lazycodex)에서 가져와 조정했습니다. OMP compatibility는
[Oh My Pi](https://github.com/can1357/oh-my-pi)를 기준으로 검토했습니다. 전체 provenance와 third-party notice는
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 및
[`third_party/SOURCE_COMMITS.json`](third_party/SOURCE_COMMITS.json)에 기록되어 있습니다.

## License

이 project는 [MIT License](LICENSE)에 따라 license됩니다.
