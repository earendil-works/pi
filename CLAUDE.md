# CLAUDE.md — NLT-Pi / NLT Coding Agent

This repository is the NLT-owned runtime and SDK foundation for the NeuroLift Technologies Coding Agent (NCA). It adopts the minimum public governance requirements and templates from [NeuroLift-Technologies/.github](https://github.com/NeuroLift-Technologies/.github), adapted to NLT-Pi's architecture and operational requirements. Treat NLT-Pi's local governance files as its repository-specific implementation.

## Mandatory reading
1. [Public governance contract](https://github.com/NeuroLift-Technologies/.github/blob/main/governance.yaml) and [public agent guide](https://github.com/NeuroLift-Technologies/.github/blob/main/AGENTS.md).
2. `GOVERNANCE.md`, `governance.yaml`, `governance.json`, and `NLT-DEV-OTOI.md` — local baseline adaptation and repository-specific authority model.
3. `AGENTS.md` — repository gateway, architecture boundaries, and engineering rules.
4. `REVIEW.md` — review format.
5. `docs/active-threads.md` — current work and blockers.
6. `nltotoi.json` — machine-readable local governance manifest.

## Project identity and boundaries
- NLT-Pi provides the TypeScript agent runtime / SDK foundation used by NLT Coding Agent.
- AgentOS is the NCA execution environment ("computer"); it is not the semantic governance authority.
- ASFDK is composed of three distinct governance layers: development-time governance, agent-runtime harness governance, and integration governance through ASFDK MCP.
- Do not collapse these layers into one generic middleware or imply that MCP is a mandatory hop for every internal action.
- Human authority remains final. Capability does not equal authority.

## Engineering rules
- Inspect the existing implementation and tests before changing behavior.
- Preserve useful inherited engineering constraints only when they remain applicable to NLT-Pi; this file and AGENTS.md supersede obsolete upstream-specific instructions.
- Do not make assumptions about package ownership, execution boundaries, or authorization. Trace the actual code path.
- Do not introduce provider lock-in, external integrations, deployment changes, or new persistence/security boundaries without approval.
- Never bypass ASFDK controls or convert model output into authority.
- Never push directly to `main`; use a feature branch and pull request.
- Follow the commit format `[AGENT_NAME] type(scope): description` and keep PRs focused on one independently reviewable concern.
- Before pushing, run the verification sequence in `AGENTS.md` ("Pre-push verification"),
  including its fresh-clone prerequisites and the conflict-marker check. Never skip hooks:
  no `--no-verify`, no `core.hooksPath` override. If the hook cannot pass, stop and escalate.
- Do not claim tests, builds, scans, or deployments ran unless they actually ran.
- Keep diffs scoped. Do not remove functionality without approval.
- No secrets, credentials, tokens, or private data in source control.
- Sign every comment made using the account owner's account with `templates/agent-comment.md` so coding-agent authorship is explicit. Applies to any coding agent (Cline, Kilo, OpenCode, Codex, Claude Code, or similar).

## Repository commands
Use the actual scripts declared by the root package.json. Do not invent or substitute commands. Before code changes, inspect relevant package scripts and test conventions.

## Handoff
At the end of significant work, update `docs/active-threads.md` and write a handoff record under `docs/agent-log/handoffs/`. Log intent before broad, sensitive, architectural, or irreversible actions. Escalate rather than guess.
