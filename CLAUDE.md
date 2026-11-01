# CLAUDE.md — NLT-Pi / NLT Coding Agent

This repository is the NLT-owned runtime and SDK foundation for the NeuroLift Technologies Coding Agent (NCA). Treat it as an independent NLT project. Do not assume upstream Pi conventions, compatibility, contribution requirements, or release processes apply.

## Mandatory reading
1. `NLT-DEV-OTOI.md` — repository governance contract and authority model.
2. `AGENTS.md` — repository gateway, architecture boundaries, and engineering rules.
3. `REVIEW.md` — review format.
4. `docs/active-threads.md` — current work and blockers.
5. `nltotoi.json` — machine-readable governance manifest.

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
- Do not claim tests, builds, scans, or deployments ran unless they actually ran.
- Keep diffs scoped. Do not remove functionality without approval.
- No secrets, credentials, tokens, or private data in source control.

## Repository commands
Use the actual scripts declared by the root package.json. Do not invent or substitute commands. Before code changes, inspect relevant package scripts and test conventions.

## Handoff
At the end of significant work, update `docs/active-threads.md` and write a handoff record under `docs/agent-log/handoffs/`. Log intent before broad, sensitive, architectural, or irreversible actions. Escalate rather than guess.
