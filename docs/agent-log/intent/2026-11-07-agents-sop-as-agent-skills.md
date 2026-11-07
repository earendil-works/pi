# NLT-Pi Intent Record

**Date:** 2026-11-07T00:00:00+00:00
**Agent / session:** Cline (delegated coding agent)
**Branch:** working tree (no branch yet — pending owner decision on feature branch/PR)
**OTOI:** NLT-PI-DEV-OTOI-1.0.1

## Intended action
Convert the repository role profiles in `agents/` (`nlt-code-reviewer.md`, `nlt-governance-steward.md`, `nlt-implementation-agent.md`) and the standard operating procedures in `SOPs/` (`incident-response.md`, `new-agent-onboarding.md`, `repo-governance-setup.md`) into loadable Agent Skills under a new `.agents/skills/` directory at the repo root. Each skill is a directory containing `SKILL.md` with Agent Skills frontmatter (`name`, `description`) followed by the instruction body, matching the existing `.claude/skills/` format and Pi's documented `.agents/skills/` project skill location (`packages/coding-agent/docs/skills.md`). Add `.agents/README.md` enumerating the skills. Original `agents/` and `SOPs/` files are retained because `nltotoi.json` required_files lists them and the governance validator enforces their presence.

## Rationale
Pi (the NLT Coding Agent) discovers project skills in `.agents/skills/`, so porting the agent profiles and SOPs into that format makes the same governance guidance loadable as skills in addition to remaining available as standalone documents. It does not change any policy, authority boundary, or enforcement behavior.

## Risks and trust boundaries
- Skill names must follow Agent Skills rules (lowercase, digits, hyphens; no leading/trailing/consecutive hyphens; ≤64 chars) and each `SKILL.md` must declare a non-empty description (≤1024 chars) or Pi will not load it.
- This adds new files but changes no behavior, grants no permissions, and overrides no human approval. Skill content is a faithful copy of `agents/` and `SOPs/` source text.
- No secrets, credentials, or external integrations are introduced.

## Alternatives considered
- Replace `agents/` and `SOPs/` with `.agents/skills/`: rejected, because `nltotoi.json` `required_files` and `validate-governance.sh` require the original paths; removing them would fail validation.
- Put skills only in `.claude/skills/`: insufficient — `.claude/` is gitignored and scoped to Claude Code; `.agents/skills/` is Pi's documented project skill location and is not gitignored.

## Human approval / escalation
This is a representation change, not an architecture, provider, deployment, security, or persistence decision, so it is within the delegated scoped-implementation authority. No human decision is required before proceeding; results are reported for owner review.

## Outcome
[Complete after execution. Record actual result and deviations.]
