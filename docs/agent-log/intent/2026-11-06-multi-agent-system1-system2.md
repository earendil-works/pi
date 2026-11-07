# NLT-Pi Intent Record

**Date:** 2026-11-06T22:30:00+00:00  
**Agent / session:** Claude (Claude Code) / `session_01UNjnjmzuJZHd8kvi7BuGFM`  
**Branch:** `docs/multi-agent-system1-system2-design`  
**OTOI:** NLT-PI-DEV-OTOI-1.0.1

## Intended action
Write the design for multi-agent orchestration in the NLT Coding Agent MVP: `docs/superpowers/specs/2026-11-06-multi-agent-system1-system2-design.md`, plus this record and a thread entry in `docs/active-threads.md`. This record covers the design only. No code is written, no dependency is added, no model is downloaded and no environment variable is set. Implementation starts only after the owner approves the written spec and a plan, and each later phase gets its own intent record.

The intent that a later implementation (phase 1) would carry out, recorded here because it changes how the runner, its tools and the models fit together:

1. A `delegate(reflex, input)` custom tool and an `apply_proposal(id)` custom tool in the governed turn, registered next to the existing tools in `mvp/src/agent/runner.ts`.
2. A reflex interface with typed input and output schemas, confidence and escalation, an owner-set allow-list, per-turn and per-call caps, and a server-built untrusted-data result block.
3. Version-one reflexes: `scout` (existing read-only sandbox operations, no model), `coder` (the one working hosted free model) and `reviewer` (deterministic checks first, then that model).
4. A switch `NLT_SUBAGENTS=1`, off by default.
5. OTOI for every reflex (added at the owner's request after the first draft). OTOI governs interaction terms; the reflex registry and the harness policy remain the only capability authority. Each reflex is an agent in the owner's `.otoi` charter; `honorer.ts` is split so verification and honoring happen once and `propagateTo(policy, agentId)` serves each agent; a delegation is refused unless the charter verifies, declares the reflex and is in `strict` mode. The server keeps its own audit line.

## Rationale
The owner asked for an orchestration setup in which one model (System 2) selects specialists (System 1) whose output is machine-readable, and approved the design in chat on 2026-11-06 (reflex kinds beyond chat models, roles `scout`, `coder`, `reviewer`, caps of 3 delegations and 60 seconds, 0.5 escalation threshold, fast path deferred). A written spec is the architectural path's required artifact before any plan or code.

## Risks and trust boundaries
- **Authority.** Reflex output is proposed intent. Nothing a reflex returns can widen egress, allow a command, pick a model or skip a check. The harness policy review, path confinement, size caps and sandbox lock apply to everything that executes.
- **Selection.** System 2 selects a reflex by name from an owner-set allow-list; no free-text model id, URL or command is accepted.
- **Prompt injection.** Reflex output is untrusted data in a delimited, size-capped, schema-validated block. A string field can still carry injected text; the block header says it is data.
- **Data flow.** A model-backed reflex sends its input to that model's provider; the data notice must say so. Version one adds no credential, no egress, no dependency and no persistence.
- **Runtime.** Delegations consume the existing turn budget (the sandbox turn aborts about 238 seconds into a 270-second request) and the 300-second function limit; caps bound them. Any failure falls back to the current single-agent turn, and a 20-second continuation reserve, measured to the turn abort time, keeps System 2 able to receive a timeout or decline before the turn-level abort.
- **Layering.** ASFDK runtime-harness layer and AgentOS execution. The crisis gate still runs first. MCP is not a hop for any of it.
- **Later phases, not approved here.** Encoder reflexes (model downloads, `huggingface.co` egress), local generators and smolagents (new dependency, Python in the sandbox), and browser reflexes (WebLLM dependency, client-side untrusted data) each cross a boundary and need their own record and approval.

## Alternatives considered
- **Virtual router model** (Pi's `jev-router.ts` pattern): one context, model swapped per phase. Rejected as the main design: it needs every model to handle the full Pi prompt and tools, which tiny models cannot, and the example needs paid credentials and provider lock-in.
- **Pi's `subagent` extension** (a separate `pi` process per subagent): rejected, because the runner disables extensions and a Vercel function should not spawn processes.
- **Subagents returning prose:** rejected in favour of schema-validated JSON, which small models handle better with constrained decoding and which gives less injection surface.
- **Reflexes writing files directly:** rejected; proposals applied through the reviewed operations keep one execution path.
- **Zero-shot encoder routers as a safety gate:** rejected; the crisis gate is unchanged and encoders are only hints.

## Human approval / escalation
Required. The owner approved the written spec on 2026-11-06 and confirmed `apply_proposal`; a same-day review then changed sections 3, 3a, 4 and 8, which the owner should re-confirm. The owner must still review a written implementation plan and choose its execution method before any code. No separate handoff for the plan stage; it goes in the overall session handoff. Every later phase needs a new intent record and approval, and any new dependency, egress host, model download or environment variable needs explicit approval. Stop and escalate if the Pi SDK cannot support the custom tools as the spec assumes.

## Outcome
Spec and this record written on branch `docs/multi-agent-system1-system2-design` and opened as a draft PR for the owner's review. Nothing is deployed from this change.

## Rollback
Close the PR. Nothing is deployed from this change.
