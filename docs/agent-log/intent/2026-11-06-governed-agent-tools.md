# NLT-Pi Intent Record

**Date:** 2026-11-06T04:54:49+00:00
**Agent / session:** Claude Code, delegated coding agent session on `NeuroLift-Technologies/nlt-pi`
**Branch:** `docs/readme-personal-use`
**OTOI:** NLT-PI-DEV-OTOI-1.0.1

## Intended action
The owner asked to incorporate more of the Pi coding agent packages and capabilities into the MVP agent. This session adds the Pi coding agent's discovery tools (`ls`, `find`) to the governed MVP agent turn, which already bound `bash`, `read`, `write` and `edit` to sandbox operations.

1. Add sandbox-backed `ls` and `find` operations to `mvp/src/sandbox/operations.ts`, behind the harness policy and confined to the workspace root (lexical and symlink-aware).
2. Register Pi's `createLsToolDefinition` and `createFindToolDefinition` in the runner's custom tool list, so the governed session gets Pi's tool definitions, schemas and limits.
3. Tests in `mvp/test/sandbox-operations.test.ts` and `mvp/test/agent-runner.test.ts`.
4. Update `mvp/README.md` and `docs/active-threads.md` (NLTPI-MVP-005).

Not in this action: a separate `grep` tool (Pi's `grep` factory cannot execute sandboxed through its operations interface, so grep remains available through the sandboxed `bash` tool), MCP servers, extensions, skills, prompt templates, context files, subagents, compaction wiring, or any route, credential, egress or persistence change.

## Rationale
The MVP agent turn had grown to four hand-picked Pi tools only. The owner asked for more of the Pi capability set, so the next increment is the read-only discovery half of Pi's local toolset, which can run inside the sandbox boundary through the existing swappable operations seam. Using Pi's own tool factories means the tool schemas, descriptions and limits come from Pi rather than being re-implemented here.

## Risks and trust boundaries
- **Execution authority:** unchanged in kind; the new tools still run through the same policy review and confinement seam as the existing ones, and refusals are not bypassable from inside the operations.
- **Escape from the workspace:** `ls` and `find` confine their target directory to the workspace root before listing or searching, including after symlink resolution; tests assert refusal before any command runs.
- **Glob safety:** `find` honours ignore patterns (for example `**/node_modules/**`) and a depth cap, so a pathological tree cannot make the walk unbounded.

## Alternatives considered
- Adding `grep` as a separate tool: rejected for this increment; Pi's `grep` factory spawns ripgrep on the host, so it cannot be sandboxed through its operations interface. Grep stays available through the sandboxed `bash` tool, which is policy-reviewed.
- Re-implementing the discovery tools inside the MVP instead of using Pi's factories: rejected; Pi's factories own the tool contract.

## Human approval / escalation
No new authority boundary, credential, dependency, egress or deployment decision was made. The owner's prior approvals (NLTPI-MVP-005: egress allow, approvals yes, Vercel login) still govern the route, which remains off by default.

## Outcome
The governed MVP agent turn now offers Pi's `bash`, `read`, `write`, `edit`, `ls` and `find` tools to the model, all bound to sandbox operations. The route, sandbox creation and model call remain unwired.
