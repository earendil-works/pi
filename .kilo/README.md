# NLT-Pi Kilo Code Governance

Repository-adapted [Kilo Code](https://kilo.ai) configuration for NLT-Pi. It is the Kilo
equivalent of `.claude/` and `.pi/`: a per-agent surface that routes Kilo into this
repository's existing governance, not a second source of policy.

## Contents
- `kilo.jsonc`: project config — rule loading, tool permissions, agents, MCP, watcher.
- `rules/`: Kilo-specific rule files (ordering, boundaries, record-keeping reminders).
- `agents/`: governance steward, code reviewer, and implementation agent profiles.
- `skills/`: the seven NLT governance skills — OTOI, registration, intent, escalation,
  handoff, commit format, incident response.

## Skills
`skills/` is a byte-identical copy of `.claude/skills/`. Kilo auto-discovers
`.kilo/skills/<name>/SKILL.md` with no config entry; the folder name must match the
`name` in each file's frontmatter.

Kilo also reads `.claude/skills/` as a compatibility directory, so on a Kilo version that
does this, the copy here is redundant. It is kept so the Kilo surface is self-contained and
does not depend on `.claude/` — which `.gitignore` excludes — remaining in place.

Two copies can drift, and a drifted governance skill is a false authority claim: one agent
would be told something different from another. `.claude/skills/` is canonical. Enforce it with:

```
node scripts/check-agent-skill-parity.mjs
```

That check is not wired into `npm run check`. If the duplication is not wanted, delete
`.kilo/skills/` and rely on the `.claude/skills/` compatibility path instead.

## Design rule: point, do not duplicate
`kilo.jsonc` loads the canonical root documents directly through its `instructions`
array — `AGENTS.md`, `CLAUDE.md`, `NLT-DEV-OTOI.md`, and `GOVERNANCE.md`. The files in
`rules/` add only what Kilo needs on top of those. Governance text is never copied here,
because a copy drifts and a drifted copy is a false authority claim.

Engineering authority and architecture boundaries are defined in root `AGENTS.md` and
`NLT-DEV-OTOI.md`. Agent profiles here are guidance, not an authorization system; actual
capability enforcement belongs to the applicable ASFDK harness and integration controls.

## Config scheme
This directory uses Kilo's current `kilo.jsonc` scheme. One config file is read by the VS
Code extension, the CLI, and **Cloud Agents** alike, and `.kilo/kilo.jsonc` takes priority
over a root-level `kilo.jsonc` when both exist.

The legacy Roo-derived scheme — `.kilocode/rules/`, `.kilocode/mcp.json`, `.kilocodemodes`,
`.kilocodeignore` — is not used here. Do not maintain both; a second config that half-loads
is worse than no config. Those paths are deliberately **not** gitignored, so that a file
Kilo genuinely requires there (for example a repository-level opt-out) can still be
committed.

Agents in `agents/` and skills in `skills/` are auto-discovered from these paths. An agent's
name comes from its filename; a skill's folder name must match the `name` in its frontmatter.

## Secrets — read before editing `kilo.jsonc`
**No secret and no environment-variable placeholder belongs in `kilo.jsonc`.**

Kilo does not resolve environment-variable placeholders in a *project* config, and a project
config that contains one is rejected as a whole. The permission deny rules would be silently
discarded with it, and the agent would run on defaults with nothing reporting that it had
happened. This is the one edit to this file that can quietly remove a guardrail, so treat it
as a governance change, not a config tweak.

Credentials belong in Kilo's credential store (`kilo auth`), the global config at
`~/.config/kilo/kilo.jsonc`, or — for Cloud Agents — the Kilo account running the agent.
None of those are in this repository. `.gitignore` excludes `.kilo/*.local.jsonc` and Kilo's
local cache, index, and plans directories.

The `read` permission denies `.env*` and `**/.env*`, and the `bash` block ends with a
`*.env*` deny that wins over every allow above it.

**Known residual gap:** Kilo's `grep` and `glob` tools remain unrestricted, so
environment-file contents are still reachable through a search. Kilo documents path
semantics for `glob` but not clearly for `grep`, and a rule whose behaviour is unverified
could block ordinary searches, so none was added. The deny rules are defense-in-depth, not
a secrets boundary — do not keep live credentials in the working tree.

The `bash` permission also denies the hook-bypass mechanisms (`--no-verify`,
`core.hooksPath`), the `git -C <dir>` forms of the destructive commands, destructive
`git branch` operations, and `git --output` (which writes a file). `find` is not allowed at
all, because `find -exec <cmd>` and `-delete` reach past rules that match on the leading
command word. `rg --pre=CMD` is downgraded to `ask`, because it runs `CMD` once per searched
file.

## A bash allowlist cannot make an agent read-only
`.kilo/agents/nlt-code-reviewer.md` and `nlt-governance-steward.md` set `edit: deny`, but
**`edit` rules do not apply to bash.** Shell redirection turns any permitted command into a
file write — `git diff > GOVERNANCE.md` matches a `git diff*` allow — and so do `tee`,
`git --output` and `rg --pre`. Both profiles therefore close with deny rules for `*>*`,
`*tee *`, `rg *--pre*`, `git *--output*` and `*.env*`, placed last so that last-match-wins
makes them override the allows above. **Any new `allow` must go above those closing rules**,
or it silently defeats them.

That is a mitigation, not a guarantee: pattern matching cannot enumerate every way a shell
writes a file. Treat these profiles as "intended read-only, best-effort enforced". The ASFDK
harness remains the only real boundary, exactly as `.kilo/rules/10-boundaries.md` says.

## Codebase indexing
`indexing.enabled` and `experimental.semantic_indexing` are both off. Indexing sends code
snippets to an embedding provider, which is both a provider decision and an
external-integration decision, and therefore the owner's. Kilo's documentation is currently
inconsistent about whether any hosted indexing engages without being enabled; if that turns
out to apply, the opt-out is a repository-level config file and it should be committed here
deliberately rather than left to a default.
