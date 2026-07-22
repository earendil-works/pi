# Ansteel Evidence-First Reviews

`pi --ansteel` runs a non-interactive, evidence-first engineering review under mandatory three-role governance:

- Tech Lead: sets the review boundary, verifies disputed claims, and writes the consensus.
- Staff Engineer: proposes and revises the technical assessment.
- QA Engineer: challenges the assessment and controls the approval gates.

All three roles must use explicitly configured, distinct `provider/model` values. A review is approved only after Tech Lead writes the consensus and both Staff Engineer and QA Engineer explicitly sign off on that immutable text. It is intended to make uncertainty and verification work visible; it does not guarantee that a model response is correct.

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

1. Tech Lead defines scope, evidence needs, and acceptance criteria.
2. Staff Engineer writes an initial assessment.
3. QA Engineer critiques the assessment.
4. Staff Engineer responds to the critique and revises it.
5. Tech Lead verifies disputed claims.
6. QA Engineer makes the veto decision.
7. Tech Lead writes the consensus only after QA's initial veto gate approves.
8. Staff Engineer signs off on the immutable Tech Lead consensus.
9. QA Engineer signs off on the same immutable consensus.

The roles receive the preceding transcript as claims to check, not as established facts. Each role has its own in-memory session for the review. Those review sessions load no extensions and no custom tools; only the configured built-in review tools are available.

## Evidence labels

Every factual claim should carry one of these labels:

| Label | Meaning | Expected treatment |
|-------|---------|--------------------|
| `L1` | Verified | Cite the concrete file, tool output, test result, or authoritative source. |
| `L2` | High confidence | State the technical basis, but do not present it as directly verified. |
| `L3` | Needs verification | State what is uncertain and how to check it. |
| `L4` | Unknown or doubtful | Say that it is unknown; do not convert it into a conclusion. |

An `L1` label requires cited evidence. A role's confidence alone does not raise a claim to `L1`.

## Approval Gates

Every approval gate is fail-closed. QA's initial veto, Staff Engineer's final sign-off, and QA Engineer's final sign-off must each put this marker on its own line:

```text
VERDICT: APPROVE
```

`VERDICT: REJECT`, a missing marker, a duplicate marker, a marker with extra whitespace, or any other response produces a `rejected` report. An initial QA rejection stops before consensus. A final rejection preserves the immutable consensus and transcript in the report, but the process exits nonzero.

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

## Reports and Governance Evidence

Every completed approval or rejection writes a complete, unedited Markdown transcript to `.pi/ansteel-reports/` by default. A configuration, model-resolution, or role-session construction failure also writes a sanitized rejected setup report, even when the configuration could not be parsed. The filename includes a UTC timestamp and a topic-derived slug.

The report records the result, all gate responses, role-model mapping, and the Tech Lead consensus. The mandatory distinct-model check proves only the resolved Pi model identities, not that any factual claim is true. Retain cited file, tool, test, or source evidence; model diversity supplements rather than replaces it.
