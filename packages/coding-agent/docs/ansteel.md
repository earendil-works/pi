# Ansteel Evidence-First Reviews

`pi --ansteel` runs a non-interactive, evidence-first engineering review under mandatory three-role governance:

- Tech Lead publishes and revises the architecture, then writes consensus only after independent verification passes.
- Staff Engineer independently challenges implementation feasibility and verifies each revision.
- QA Engineer independently challenges safety, testability, and evidence, and verifies each revision.

All three roles must use explicitly configured, distinct `provider/model` values. There is no fourth reviewer or sign-off role. A review is approved only after the architecture passes the Staff and QA verification gate, Tech Lead writes consensus, and both Staff Engineer and QA Engineer explicitly sign off on that immutable text. The protocol makes uncertainty and verification work visible; it does not guarantee that a model response is correct.

## Run a review

From the project being reviewed, first create the required `.pi/ansteel.json` configuration, then run:

```bash
pi --ansteel "Review the motor safety change"
```

`--ansteel` uses non-interactive output. It prints the result and path to the saved Markdown report, for example:

```text
Ansteel review approved: /project/.pi/ansteel-reports/ansteel-2026-07-22-10-30-00-review-the-motor-safety-change.md
```

There is no fallback to the current Pi model. Before naming each role model, make sure it is available and authenticated in Pi. Use `/login`, `pi --list-models`, and the normal [Providers](providers.md) and [Custom models](models.md) setup as needed.

## Review flow

The coordinator runs these stages in order:

1. Tech Lead publishes architecture version 0, including boundary, constraints, components, data/control flow, failure handling, evidence plan, and acceptance criteria.
2. Staff Engineer independently writes an implementation challenge against that architecture snapshot.
3. QA Engineer independently writes a safety and testability challenge against the same snapshot.
4. For at most two revision rounds, Tech Lead publishes a complete architecture revision that resolves every open challenge.
5. Staff Engineer verifies the revised architecture.
6. QA Engineer verifies the same revised architecture independently.
7. If both verifiers approve, Tech Lead writes consensus; otherwise a valid rejection creates the next revision round. Exhausting the cap rejects the review.
8. Staff Engineer signs off on the immutable consensus.
9. QA Engineer signs off on the same immutable consensus.

The initial Staff and QA challenge prompts contain only the same architecture version 0, not the other role's response. A revision sees the prior architecture and both challenge records. The Staff and QA verification prompts each see the same revised architecture and challenge ledger, but not the other verifier's current-round response. Each role has its own in-memory session for the review. Those review sessions load no extensions and no custom tools; only the configured built-in review tools are available.

## Challenge ledger

Every required change in an initial challenge must use its own exact marker, followed by evidence, impact, and an acceptance condition:

```text
ISSUE: STAFF-1
```

Use an uppercase unique ID such as `STAFF-1` or `QA-1`. When a reviewer has no required change, put this exact marker on its own line:

```text
NO ISSUES
```

Each Tech Lead architecture revision must include this exact marker for every open challenge ID:

```text
RESOLUTION: STAFF-1 | RESOLVED
```

Missing, duplicated, unknown, or malformed issue and resolution markers reject the review. A verification rejection must add at least one new `ISSUE` marker; a rejection without a new issue is rejected as unsupported rather than silently retried.

## Evidence labels

Every factual claim should carry one of these labels:

| Label | Meaning | Expected treatment |
|-------|---------|--------------------|
| `L1` | Verified | Cite the concrete file, tool output, test result, or authoritative source. |
| `L2` | High confidence | State the technical basis, but do not present it as directly verified. |
| `L3` | Needs verification | State what is uncertain and how to check it. |
| `L4` | Unknown or doubtful | Say that it is unknown; do not convert it into a conclusion. |

An `L1` label requires cited evidence. A role's confidence alone does not raise a claim to `L1`.

## Approval gates

Both verification stages and both final sign-off stages are fail-closed. An approval must use this marker on its own line:

```text
VERDICT: APPROVE
```

During verification, an exact `VERDICT: REJECT` plus at least one new issue enters the next architecture revision round. A missing marker, duplicate marker, marker with extra whitespace, malformed marker, or rejection without a new issue rejects the review immediately. After two unsuccessful revision rounds, the review is rejected and archived. A final Staff or QA sign-off rejection is terminal: it preserves the immutable consensus and transcript in the report, but the process exits nonzero.

## Per-role configuration

Create `.pi/ansteel.json` in the project being reviewed. The `model` field is required for every role, and all three configured `provider/model` values must be distinct. Missing, invalid, duplicate, or unavailable role models reject the review before any role session is created.

```json
{
  "roles": {
    "tech-lead": {
      "model": "<provider-a>/<model-id-a>",
      "tools": ["read", "grep", "find", "ls", "bash"]
    },
    "staff-engineer": {
      "model": "<provider-b>/<model-id-b>",
      "tools": ["read", "grep", "find", "ls", "bash"]
    },
    "qa-engineer": {
      "model": "<provider-c>/<model-id-c>",
      "tools": ["read", "grep", "find", "ls"]
    }
  },
  "reportDirectory": ".pi/ansteel-reports"
}
```

`model` must use the exact `provider/model` form known to Pi, and that provider must have configured authentication. There is no current-model fallback.

The only allowed role tools are `read`, `grep`, `find`, `ls`, and `bash`. By default, Tech Lead and Staff Engineer receive all five. QA receives `read`, `grep`, `find`, and `ls`; QA cannot be granted `bash`. No review role can receive `edit`, `write`, extension tools, or SDK custom tools through this configuration.

`reportDirectory` is resolved from the project directory and must remain inside it. Omit it to use the default `.pi/ansteel-reports` location.

## Reports and governance evidence

Every completed approval or rejection writes a complete, unedited Markdown transcript to `.pi/ansteel-reports/` by default. A configuration, model-resolution, or role-session construction failure also writes a sanitized rejected setup report, even when the configuration could not be parsed. The filename includes a UTC timestamp and a topic-derived slug.

The report records the result, challenge ledger, revision-round outcomes, complete role responses, role-model mapping, and Tech Lead consensus when it exists. The distinct-model check proves only the resolved Pi model identities, not that any factual claim is true. Retain cited file, tool, test, or source evidence; model diversity supplements rather than replaces it.
