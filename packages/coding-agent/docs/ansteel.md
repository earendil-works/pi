# Ansteel Evidence-First Reviews

`pi --ansteel` runs a non-interactive, evidence-first engineering collaboration under mandatory three-role governance:

- Tech Lead independently investigates, publishes a work card, challenges peer claims, responds to assigned challenges, and verifies each revision.
- Staff Engineer independently investigates, publishes a work card, challenges peer claims, responds to assigned challenges, and verifies each revision.
- QA Engineer independently investigates, publishes a work card, challenges peer claims, responds to assigned challenges, and verifies each revision.

All three roles normally use explicitly configured, distinct `provider/model` values. There is no fourth reviewer or sign-off role. A review is approved only after all three revised work cards pass independent verification, Tech Lead writes consensus, and both Staff Engineer and QA Engineer explicitly sign off on that immutable text. The protocol makes uncertainty and verification work visible; it does not guarantee that a model response is correct.

## Run a review

From the project being reviewed, first create the required `.pi/ansteel.json` configuration, then run:

```bash
pi --ansteel "Review the motor safety change"
```

`--ansteel` uses non-interactive output. It prints a stage-progress line as each role begins, completes, fails, or times out. At completion it prints the complete discussion transcript, followed by the result and path to the saved Markdown report, for example:

```text
Ansteel review approved: /project/.pi/ansteel-reports/ansteel-2026-07-22-10-30-00-review-the-motor-safety-change.md
```

There is no fallback to the current Pi model. Before naming each role model, make sure it is available and authenticated in Pi. Use `/login`, `pi --list-models`, and the normal [Providers](providers.md) and [Custom models](models.md) setup as needed.

## Review flow

The coordinator runs these stages in order:

1. Tech Lead, Staff Engineer, and QA Engineer each independently investigate the same topic and publish a work card. Their work-card prompts do not include another role's conclusion.
2. Each role receives the same three work cards and independently cross-examines the other roles' claims, evidence, omissions, alternatives, and trade-offs.
3. For at most two revision rounds, every role publishes a response and revised work card that resolves every open challenge assigned to that role.
4. Tech Lead, Staff Engineer, and QA Engineer independently verify the same set of three revised work cards. Their current-round verification answers are not shared until all three are complete.
5. All three verifiers must approve. A valid rejection creates the next revision round; exhausting the cap rejects the review.
6. Tech Lead writes consensus from the visible evidence, followed by immutable Staff Engineer and QA Engineer sign-off.

Work cards must contain visible Markdown headings with nonempty body content for `Conclusion`, `Evidence`, `Assumptions and Unknowns`, `Alternatives and Trade-offs`, `Self-Refutation Conditions`, and `Questions for Peers`. Missing any required heading or leaving its body empty rejects the review. The transcript shares these auditable materials, not hidden model reasoning. Each role still has its own in-memory session, role-local memory, and configured Skill set; role sessions load no extensions or custom tools.

Every role stage has a total wall-clock deadline independent of the provider HTTP idle timeout. The default is 120 seconds. When that deadline expires, Pi aborts the active role session, rejects the review with `stage-timeout`, and continues through normal cleanup and report writing rather than waiting indefinitely.

## Challenge ledger

Every required cross-examination change must use its own exact marker, followed by evidence, impact, and an acceptance condition:

```text
ISSUE: STAFF-1 | TARGET: qa-engineer
```

Use an uppercase unique ID such as `STAFF-1` or `QA-1` and target another role. A role cannot target itself. During cross-examination, every reviewer must explicitly cover both peer roles. For each peer, emit one or more issue markers targeted at that peer, or this exact marker on its own line:

```text
NO ISSUES | TARGET: qa-engineer
```

Plain `NO ISSUES` remains shorthand for both peers only. It cannot coexist with an `ISSUE` marker or a targeted `NO ISSUES` marker. A targeted `NO ISSUES` marker may coexist with issues for the other peer. Do not emit it for a peer that already has an issue; normal agent responses sometimes add it as a redundant "no additional issues" summary, which is tolerated and does not cancel the recorded issues.

Each role revision must include this exact marker for every open challenge assigned to that role. Do not emit a resolution marker when no challenge is assigned:

```text
RESOLUTION: STAFF-1 | RESOLVED
```

Missing, duplicated, unknown, self-targeted, or malformed issue and resolution markers reject the review. A verification rejection must add at least one new targeted `ISSUE` marker; a rejection without a new issue is rejected as unsupported rather than silently retried.

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

All three verification stages and both final sign-off stages are fail-closed. An approval must use this marker on its own line:

```text
VERDICT: APPROVE
```

Each verification prompt requires its response's final nonblank line to be exactly `VERDICT: APPROVE` or exactly `VERDICT: REJECT`. A verifier that rejects must emit at least one new targeted issue marker before that final verdict line. During verification, an exact `VERDICT: REJECT` plus at least one new targeted issue enters the next collaborative revision round. A missing marker, duplicate marker, marker with extra whitespace, malformed marker, or rejection without a new issue rejects the review immediately. After two unsuccessful revision rounds, the review is rejected and archived. A final Staff or QA sign-off rejection is terminal: it preserves the immutable consensus and transcript in the report, but the process exits nonzero.

## Per-role configuration

Create `.pi/ansteel.json` in the project being reviewed. The `model` field is required for every role, and all three configured `provider/model` values must be distinct by default. Missing, invalid, duplicate, or unavailable role models reject the review before any role session is created.

```json
{
  "roles": {
    "tech-lead": {
      "model": "<provider-a>/<model-id-a>",
      "tools": ["read", "grep", "find", "ls", "bash"],
      "memoryFile": ".pi/ansteel-memory/tech-lead.md",
      "skillPaths": [".pi/ansteel-skills/tech-lead"]
    },
    "staff-engineer": {
      "model": "<provider-b>/<model-id-b>",
      "thinkingLevel": "high",
      "tools": ["read", "grep", "find", "ls", "bash"]
    },
    "qa-engineer": {
      "model": "<provider-c>/<model-id-c>",
      "tools": ["read", "grep", "find", "ls", "bash"]
    }
  },
  "reportDirectory": ".pi/ansteel-reports",
  "stageTimeoutMs": 120000,
  "maxToolCallsPerStage": 8,
  "allowSingleModel": false
}
```

Set `allowSingleModel` to `true` only for an intentional same-model discussion. It retains independent role sessions, role tools, challenge gates, and QA veto, but reports must not be interpreted as cross-model verification.

`model` must use the exact `provider/model` form known to Pi, and that provider must have configured authentication. There is no current-model fallback.

`thinkingLevel` is optional per role and accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Pi clamps the selected level to the configured model's supported levels. Set it explicitly when a provider requires thinking to be enabled; it does not change the role's tool or governance permissions.

`memoryFile` is optional and names one role-local Markdown or text file inside the reviewed project. Its content is added only to that role's session as fallible background context. `skillPaths` is an optional array of role-local Skill files or directories inside the reviewed project. Ansteel sessions load only the paths listed for their own role; ordinary project and user Skills remain disabled during a review. A missing configured memory file rejects setup; a missing Skill path is reported by Pi's resource loader.

Keep API credentials out of `.pi/ansteel.json`. Configure authentication through Pi's existing provider settings or environment variables, and use separate provider aliases in each role's `provider/model` value when the roles need distinct API keys or endpoints.

The only allowed role tools are `read`, `grep`, `find`, `ls`, and `bash`. By default every role receives all five so each can independently inspect source, run bounded evidence commands, and verify peer claims. `bash` remains limited by the per-stage tool budget and an explicit timeout of at most 20 seconds. No review role can receive `edit`, `write`, extension tools, or SDK custom tools through this configuration.

`reportDirectory` is resolved from the project directory and must remain inside it. Omit it to use the default `.pi/ansteel-reports` location.

`stageTimeoutMs` is optional and defaults to `120000`. It must be an integer from `1` through `2147483647` milliseconds and cannot be disabled. The limit covers an entire role stage, including tool use and provider retries; it is separate from Pi's provider HTTP idle timeout.

`maxToolCallsPerStage` is optional and defaults to `4`. It must be an integer from `1` through `32`. A tool request beyond the configured budget rejects the current review stage rather than allowing an unbounded tool loop.

## Reports and governance evidence

Every completed approval or rejection writes a complete, unedited Markdown transcript to `.pi/ansteel-reports/` by default. A configuration, model-resolution, or role-session construction failure also writes a sanitized rejected setup report, even when the configuration could not be parsed. The filename includes a UTC timestamp and a topic-derived slug.

The report records the result, challenge ledger, revision-round outcomes, complete role responses, role-model mapping, and Tech Lead consensus when it exists. The distinct-model check proves only the resolved Pi model identities, not that any factual claim is true. Retain cited file, tool, test, or source evidence; model diversity supplements rather than replaces it.
