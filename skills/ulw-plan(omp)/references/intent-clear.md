# CLEAR intent

Use this path when the user knows the outcome or explicitly requests an interview.

## Ground first

Inspect repository patterns, constraints, tests, and primary documentation before asking anything.
Classify each unknown as a discoverable fact or an owner decision. Research discoverable facts.
Treat a doubtful classification as an owner decision.

Lock the topology before depth: record one to six components that can succeed or fail
independently. Give each component an outcome, status, and evidence path in the durable draft.

## Filter questions

Apply both filters to every candidate question:

1. If evidence can answer it, research it.
2. If stated intent plus a reversible default can answer it, adopt and record the default.

Always surface an owner decision: an irreversible, destructive, or safety-critical choice, or a
cross-cutting product decision such as public configuration, distribution, dependency, or data
shape. An explicit interview request disables default adoption for surviving forks.

Ask one to three narrow questions per turn. Explain what was inspected, why evidence did not settle
the fork, and which plan section changes with the answer. Put the recommended option first. Confirm
the test strategy even though every todo must include agent-executed happy and failure QA.

## Reach clearance

Proceed to the brief only when the objective, scope in/out, approach, test strategy, and every
blocking ambiguity are resolved. Persist `status: awaiting-approval` before presenting the brief.
Approval is not execution.

After explicit approval, persist `status: approved` and `approval: explicit-user-approval`, create
the plan skeleton, run the mandatory gap review, and append the detailed plan. If review was already
required, run the dual review. Otherwise ask whether to start work or run the dual review, then stop.
Never implement.
