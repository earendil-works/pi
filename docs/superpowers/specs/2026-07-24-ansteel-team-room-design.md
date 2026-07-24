# Ansteel Team Room Design

## Goal

Turn Ansteel from a one-shot review command into an interactive project team: Tech Lead, Staff Engineer, and QA Engineer retain separate normal Pi sessions while publishing auditable collaboration events to one user-visible project timeline.

## Scope

This first increment creates the durable collaboration substrate. It does not yet run parallel writes or automatically commit code.

- Reuse `.pi/ansteel.json` for role model, thinking, role-local memory, and Skill configuration.
- Persist one session per role and an append-only team event ledger under `.pi/ansteel-team/`.
- Give each role its own ordinary Pi `AgentSession`; role sessions keep their own conversation history and receive ordinary coding tools only after task ownership is introduced in the next increment.
- Provide interactive commands to start, inspect, send work to, and stop a team.
- Broadcast public role summaries, evidence, questions, and status to the host Pi timeline. Hidden reasoning is never copied between roles.

## Interaction Model

`/ansteel-team start <topic>` validates the three configured role models, creates or resumes the team state, then asks all three roles to investigate the topic independently. Each role's public response is recorded as an event and rendered in the host conversation.

`/ansteel-team ask <message>` sends the user message plus the current public ledger snapshot to each role. Calls run sequentially in this increment so the ledger order is deterministic. A role sees its own private session history and the public collaboration record, but never another role's hidden reasoning.

`/ansteel-team status` renders current role session state, the topic, open challenges, and the most recent public event. `/ansteel-team stop` disposes live sessions without deleting persisted state; a later `start` resumes the stored role sessions.

## State and Evidence

The project-local `team.json` stores a versioned team identity, topic, role model references, session-file locations, lifecycle status, and monotonically increasing event sequence. `events.jsonl` is append-only and contains only public material:

- role report: conclusion, evidence references, assumptions, alternatives, and public questions;
- challenge: unique ID, author, target role, impact, and acceptance condition;
- resolution: linked challenge ID and verifiable outcome;
- task and change events for future execution increments.

The event record includes the role, timestamp, sequence number, and a bounded public content field. It never stores API keys, provider payloads, hidden thinking, or raw tool output.

## Governance

All roles may investigate, propose, challenge, and later implement. Responsibilities decide the default focus, not who is allowed to raise a concern. A public challenge must name its target and an open challenge cannot be silently erased. QA retains a veto only through a recorded challenge.

The first increment is deliberately read-oriented. The follow-up increment adds explicit task claiming and a write gate: `edit` and `write` are permitted only for the role that holds the corresponding task lease; every completed change publishes its diff and test evidence for peer review.

## Failure Handling

Missing configuration, unauthenticated role models, corrupt state, missing role sessions, or a failed role turn emit a public failure event and leave the team resumable. No failure produces a false approval. State writes use a replace operation and validate the schema on every load.

## Tests

Unit tests cover state creation, path containment, persisted event ordering, challenge lifecycle, role-session restoration metadata, invalid configurations, and public ledger rendering. Extension tests exercise command registration and the start/status/stop lifecycle with fake role-session factories; no paid provider is invoked.
