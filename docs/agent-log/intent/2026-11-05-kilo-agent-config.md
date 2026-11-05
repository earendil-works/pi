# NLT-Pi Intent Record

**Date:** 2026-11-05T04:45:06+00:00  
**Agent / session:** Claude (Claude Code, claude-opus-5) / `01UNjnjmtbn8V5V114283EeV`  
**Branch:** `feat/kilo-agent-config`  
**OTOI:** NLT-PI-DEV-OTOI-1.0.1

## Intended action
Add a `.kilo/` agent-configuration surface for Kilo Code, as the Kilo peer of the existing
`.claude/` and `.pi/` directories. Files added:

- `.kilo/kilo.jsonc` — rule loading, tool permissions, empty `mcp`, watcher ignores, indexing off.
- `.kilo/rules/` — four Kilo-specific rule files (session start, boundaries, commits/PRs, records).
- `.kilo/agents/` — governance steward, code reviewer, implementation agent profiles.
- `.kilo/skills/` — byte-identical copies of the seven skills in `.claude/skills/`.
- `.kilo/README.md` — what the directory is, and its secrets and indexing constraints.
- `scripts/check-agent-skill-parity.mjs` — fails when `.kilo/skills/` diverges from `.claude/skills/`.
- `.gitignore` — ignore Kilo local state (`.kilo/*.local.jsonc`, cache, index, plans).

No runtime, package, harness, or MVP code is touched. No root `package.json` script is changed.

## Rationale
The owner uses Kilo Cloud Agents against this repository, and a `[kilo]`-tagged commit is
already in `main` (`0514e09`). Without a project configuration Kilo works here with default
permissions and without the repository's governance in context. This routes Kilo into the
governance that already exists rather than creating a second source of policy: `kilo.jsonc`
loads `AGENTS.md`, `CLAUDE.md`, `NLT-DEV-OTOI.md`, `GOVERNANCE.md`, and `REVIEW.md` directly
through its `instructions` array, and the files under `.kilo/rules/` add only Kilo-specific
operational detail on top. Governance text is not duplicated, because a drifted copy is a
false authority claim.

## Risks and trust boundaries

**The permission rules are not an enforcement boundary.** They mirror the deny list in
`.claude/settings.json` (no force-push, no `reset --hard`, no recursive `rm`, no direct push
to `main`, no publish/release) and additionally deny edits to the governance documents
themselves. They are convenience and defense-in-depth. Capability is still not authority,
and real mediation belongs to the ASFDK harness. Both `.kilo/README.md` and
`.kilo/rules/10-boundaries.md` state this so the file is not mistaken for enforcement.

**A credential or environment-variable placeholder in `kilo.jsonc` would silently void the
deny rules.** Kilo does not resolve such placeholders in a project config and rejects the
whole file when one is present, discarding the permission rules with it; the agent would
then run on defaults with nothing reporting the change. This is the one edit to the file
that can quietly remove a guardrail. It is a prominent warning at the top of `kilo.jsonc`
and a README section. The warning deliberately does not spell out the placeholder syntax, in
case the check is a raw text scan rather than a parse — an earlier draft that included the
literal token could itself have triggered the rejection it warned about.

**No external-integration or provider decision is made here.** `mcp` is empty, no model is
pinned on any agent, and `indexing.enabled` and `experimental.semantic_indexing` are both
`false`. Kilo's documentation disagrees with itself about whether any hosted indexing engages
without being enabled; that conflict is recorded rather than resolved, and the decision is
left to the owner. Legacy `.kilocode/` paths are deliberately **not** gitignored so that a
repository-level opt-out file can still be committed if that mechanism turns out to apply.

**Duplication risk.** `.kilo/skills/` copies `.claude/skills/`, and Kilo also reads
`.claude/skills/` as a compatibility directory, so the copy may be redundant on the owner's
Kilo version. Two copies can drift, and a drifted governance skill would tell one agent
something different from another. `scripts/check-agent-skill-parity.mjs` fails on any
divergence; it is intentionally not wired into `npm run check`, as changing the check
pipeline is the owner's decision.

**Scope note.** The permission posture here is ask-by-default, which is more conservative
than the owner's 2026-11-05 clarification that "approvals yes" lets sandboxed agent turns run
without extra prompts. That clarification concerns the MVP's own sandboxed runner, a different
execution context from Kilo operating on this working tree, so it was not applied here.

## Alternatives considered
- **Rely only on Kilo's `.claude/skills/` compatibility path and add no `.kilo/skills/`.**
  Rejected because the owner asked for the skills in `.kilo/`, and because `.gitignore` lists
  `.claude/`, so the Kilo surface should not depend on that directory staying in place. The
  parity check mitigates the resulting duplication.
- **Symlink `.kilo/skills` to `.claude/skills`.** Rejected: single source, but symlinks are
  unreliable on Windows checkouts, and this repository ships Windows test scripts.
- **The legacy `.kilocode/` scheme.** Rejected: current Kilo reads one `kilo.jsonc` across the
  VS Code extension, the CLI, and Cloud Agents, and `.kilo/kilo.jsonc` takes priority over a
  root `kilo.jsonc`. Maintaining both schemes risks a half-loaded config.
- **Copy governance text into `.kilo/rules/`.** Rejected: duplication drifts, and a drifted
  governance rule is a false authority claim. The rules point at the root documents instead.

## Human approval / escalation
No approval required for the change as scoped: it adds an agent-configuration surface and a
check script, and makes no architecture, provider, persistence, deployment, or external
integration decision.

Three decisions remain the owner's and are deferred, not assumed:
1. Whether to keep `.kilo/skills/` at all, given Kilo's `.claude/skills/` compatibility path.
2. Whether to wire `scripts/check-agent-skill-parity.mjs` into `npm run check`.
3. Whether to add a `.kilocode/config.json` hosted-indexing opt-out, pending clarity on
   whether that mechanism applies to Cloud Agents.

## Outcome
Executed as described on `feat/kilo-agent-config`.

Verified in the cloud container: `.kilo/kilo.jsonc` parses after comment stripping and
contains no secret or placeholder token; all nine `instructions` paths resolve; the three
agent files have valid YAML frontmatter; all seven skill folder names match their frontmatter
`name`; `scripts/check-agent-skill-parity.mjs` passes and was confirmed to fail on
deliberately introduced drift; `bash .nltotoi/scripts/validate-governance.sh` reports 71
passed, 0 failed. Re-verified after fast-forwarding to `origin/main` at `6fcd6f2`.

NOT verified: `npm run check`, biome, and the repository test suites were not run, because
this container has no installed `node_modules`. No Kilo client was available, so Kilo has
never loaded this configuration — the permission rules, agent discovery, and skill discovery
are unverified against a real Kilo build. The owner should confirm Kilo picks up `.kilo/`
before relying on it.

Deviation from the original request: the first draft gitignored `.kilocode/`,
`.kilocodemodes`, and `.kilocodeignore` as a guard against a drifting dual config. That was
reverted, because it would have made a repository-level file that Kilo may require there
uncommittable.
