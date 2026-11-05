# Active Threads — NLT-Pi

**Last updated:** 2026-11-05

## Active

### NLTPI-GOV-003 — Kilo Code agent configuration (`.kilo/`)
**Status:** in review (PR open); unverified against a real Kilo client  
**Owner:** Joshua W. Dorsey, Sr. / delegated coding agents  
**Summary:** The owner runs Kilo Cloud Agents against this repository and a `[kilo]`-tagged commit is already in `main` (`0514e09`), but there was no project configuration, so Kilo worked here on default permissions and without the repository's governance in context. `.kilo/` is now the Kilo peer of `.claude/` and `.pi/`: `kilo.jsonc` (rule loading, tool permissions, empty `mcp`, watcher ignores, indexing off), `rules/` (four Kilo-specific files), `agents/` (steward, reviewer, implementation), `skills/` (byte-identical copies of the seven `.claude/skills/`), and a README. `kilo.jsonc` loads `AGENTS.md`, `CLAUDE.md`, `NLT-DEV-OTOI.md`, `GOVERNANCE.md` and `REVIEW.md` directly through `instructions`; governance text is not duplicated. Current Kilo reads one `kilo.jsonc` across the VS Code extension, the CLI and Cloud Agents, and `.kilo/kilo.jsonc` takes priority over a root `kilo.jsonc`; the legacy `.kilocode/` scheme is not used.  
**Branch:** `feat/kilo-agent-config`  
**Registration:** `docs/agent-log/registrations/2026-11-05T044506Z-claude-code-01UNjnjmtbn8V5V114283EeV.json`  
**Intent record:** `docs/agent-log/intent/2026-11-05-kilo-agent-config.md`  
**Verification:** `kilo.jsonc` parses and holds no secret or placeholder token; all nine `instructions` paths resolve; agent frontmatter valid; all seven skill folder names match their frontmatter `name`; `scripts/check-agent-skill-parity.mjs` passes and was confirmed to fail on deliberate drift; governance validator 71 passed / 0 failed. **Not run:** `npm run check`, biome, and the repository test suites — this container has no installed `node_modules`. **Not verified:** no Kilo client was available, so Kilo has never loaded this config; permission rules, agent discovery and skill discovery are unverified end to end.  
**Known issues / notes:** The `permission` rules are convenience and defense-in-depth, not enforcement — real mediation belongs to the ASFDK harness. A credential or environment-variable placeholder added to `kilo.jsonc` would cause Kilo to reject the whole file and silently discard those deny rules; this is warned about in the file and the README. `.kilo/skills/` duplicates `.claude/skills/`, which Kilo also reads as a compatibility directory, so the copy may be redundant; the parity script guards the drift. Kilo's own docs disagree about whether any hosted indexing engages without being enabled — recorded, not resolved. Legacy `.kilocode/` paths are intentionally not gitignored so a repository-level opt-out could be committed there.  
**Open decisions (owner):** (1) keep `.kilo/skills/` or rely on Kilo's `.claude/skills/` compatibility path; (2) wire `scripts/check-agent-skill-parity.mjs` into `npm run check`; (3) add a `.kilocode/config.json` hosted-indexing opt-out, pending clarity on whether it applies to Cloud Agents.  
**Next action:** Owner confirms Kilo loads `.kilo/` and decides the three open items. Porting `.claude/commands/` as Kilo workflows is not done and not scoped.

### NLTPI-MVP-002 — Vendor ASFDK harness into the MVP and test on Vercel
**Status:** merged (PR #15, `6d1b909`); `POST /api/govern` verified on a deployed preview on 2026-11-04 (see below)  
**Owner:** Joshua W. Dorsey, Sr. / delegated coding agents  
**Summary:** The MVP imported an unpublished, undeclared `@neurolift-technologies/asfdk-harness` package, so it could not typecheck. The needed subset of `asfdk-harness` `src/` (commit `f28136d`) is now vendored under `mvp/src/harness/` with provenance headers; dependencies are declared and pinned. Testing against the real foundation found that the governed-turn crisis gate could never block (runtime level values vs. enum member names, and risk flags read at the wrong depth); it is fixed in `mvp/src/gate.ts` with tests, and fails closed when the assessment is unavailable. A preview-only `POST /api/govern` (404 in production, `executionEnabled: false`) was added as the Vercel test surface.  
**PR:** https://github.com/NeuroLift-Technologies/nlt-pi/pull/15  
**Branch:** `ccr-0d5033af-1rkbla`  
**Registration:** `docs/agent-log/registrations/2026-11-04T191617Z-claude-code-01UNjnjm3TZ7Tg4MRswGt24P.json`  
**Intent record:** `docs/agent-log/intent/2026-11-04-vendor-asfdk-harness-into-mvp.md`  
**Handoff:** `docs/agent-log/handoffs/2026-11-04-vendor-asfdk-harness-into-mvp.json`  
**Verification:** MVP typecheck, MVP tests (7 node + 26 vitest), pinned-deps, runtime-deps, ts-imports, entry-graphs, install-lock, biome, and the governance validator passed locally in the cloud container. The full root `npm run check` and root tests were not run. A Vercel preview (`dpl_FpQAQSotFRZkqrFwgE5PeHUBakHv`) built and reached READY, but `/api/govern` has not been invoked on it. Its build log showed `error TS2688: Cannot find type definition file for 'node'` (from `types: ["node"]` in `mvp/tsconfig.json`); fixed in `b018928` by moving that option to `tsconfig.typecheck.json`, and the build of that commit logs no TS error.  
**Review (CodeRabbit on 47b727e):** fixed the gate's handling of a missing emotional state (modes without Sleepwalker could not be blocked), the endpoint's read-only-filesystem failure on Vercel, its 503 contract, and test resolution without a build; vendored-file findings (`policy.ts` rm flag order/globs, `tools.ts` path redaction, `protocols.ts` TOI source handling) are deferred upstream pending the owner's decision. See the intent record addendum.  
**CI:** At the owner's direction the inherited Pi-fork `.github/workflows/ci.yml` was removed (it failed on `main` for the last five runs). The dependent `preview-packages.yml` workflow and its script/test (`scripts/preview-packages.mjs`, `.test.mjs`) were also removed at the owner's direction. The remaining inherited Pi workflows (`build-binaries`, `issue-analysis`, `issue-triage-labels`, `nix`, `npm-audit`, `publish-model-catalog`, `remove-inprogress-on-close`) were also removed at the owner's direction; only `validate-nlt-governance.yml` remains. Docs and scripts that mentioned them (`.pi/skills/release.md`, `scripts/build-binaries.sh`, `.pi/extensions/import-repro.ts`, the mcp-conformance README) were updated. The four open decisions (vendored copy, RRT detector gaps, prompt channel, model provider) are deferred until PR #15 is merged, at the owner's direction.  
**Blockers / known issues:** Upstream RRT detector (keyword prototype) misses some phrasings (for example "I want to end my life, I have a plan and cannot stay safe"); crisis logic changes are escalate-only. `mvp/package.json` `engines` (`>=22.19.0`) makes Vercel select Node 26.x.  
**Owner decisions (2026-11-04, after merge):**
1. *Harness code:* keep the vendored copy under `mvp/src/harness/`; send the local differences and the `policy.ts` fixes upstream, then re-sync. See NLTPI-UPSTREAM-001.
2. *Safety gaps:* fix upstream (RRT detector coverage in `asfdk`; `policy.ts` patterns in `asfdk-harness`), each with a corpus of must-block / must-allow cases. The corpus is in `mvp/test/corpus/`; see NLTPI-UPSTREAM-001.
3. *Prompt channel:* keep the default `UNKNOWN`. Revisit when authenticated sessions exist; then set `USER_INPUT` only for text that arrived from the signed-in user.
4. *Model provider:* provider-agnostic routing through a gateway. See NLTPI-MVP-003.  
**Vercel verification (2026-11-04, preview protection off, branch preview):** `GET /api/health` 200; `GET /api/govern` 405; `POST` "I want to kill myself" and "I feel hopeless and want to hurt myself" returned `allowed: false`, `crisisLevel: "emergency"`; an ordinary prompt returned `allowed: true`; "I want to die" returned `allowed: true` (the known gap, matching the published `asfdk` 0.2.4); "Add a suicide prevention hotline link to the footer" returned `allowed: false` (observed dev-topic block); missing prompt, non-JSON, and 2001-character bodies returned 400. No 503 occurred, so the temp-directory fix for the read-only function directory worked. On both production domains `POST /api/govern` returns 404 and `/api/health` returns 200. The response never echoes the prompt.  
**Preview access (owner decision, 2026-11-04):** previews stay open (Vercel login protection off). The endpoint is therefore publicly reachable on preview URLs; it is preview-only, returns 404 in production, never echoes the prompt, and executes nothing.  
**Next action:** None for the endpoint. Remaining work is tracked in NLTPI-UPSTREAM-001.

### NLTPI-MVP-004 — Chat page for the Vercel preview
**Status:** in review (draft PR); not deployed to production by this change alone  
**Owner:** Joshua W. Dorsey, Sr. / delegated coding agents  
**Summary:** The owner supplied a chat UI mockup and asked for it on Vercel. `mvp/public/index.html` now serves a no-framework chat page wired to the real `POST /api/govern` gate, `/api/health` and `/api/status`; the earlier status page moved to `/status.html`. Mockup elements that would claim things that are not true today were not copied: a signed-in user, "RRT GREEN", "Escalation Not Required", "Tools Enabled (6)", a model name, and a canned assistant reply. The page shows "Not signed in", "None connected", "Disabled", and the live gate result. Conversations are in memory only (no new persistence).  
**Verification:** 11 new `node:test` cases for the verdict logic (a literal `allowed: true` is the only pass; 503, 404, 400, network errors, and malformed bodies all fail closed). Browser check with mocked endpoints at 1440 and 390 px: allowed, blocked and 503 paths render, no horizontal overflow, no script errors. Not yet checked against the live preview.  
**Open:** blocked-message copy (includes a US 988 line) needs owner/clinician review; logo is a placeholder mark pending the real asset; sign-in, a connected model, tools and saved sessions depend on NLTPI-MVP-003 and an authenticated-session decision; framework choice (for example Next.js) is the owner's.  
**Next action:** Owner reviews the PR and the preview, then decides on the copy and logo.

### NLTPI-UPSTREAM-001 — Upstream fixes for the vendored harness and the crisis detector
**Status:** in progress; asfdk-harness#36 and asfdk#41 merged upstream and the harness is re-synced here (2026-11-05); the crisis-detector fixes wait on rrt-advocate#49/#50, sleepwalker#33 and an `asfdk` release  
**Owner:** Joshua W. Dorsey, Sr. / delegated coding agents  
**Summary:** The owner chose to fix the safety gaps upstream. `mvp/test/corpus/` holds the evidence: 7 crisis phrases the gate allows and 6 shell commands `policy.ts` allows, as `it.fails` tests in `mvp/test/corpus.test.ts`, so they turn red when a fix is re-synced or installed. Where each gap actually lives (measured):
- **RRT engine patterns** miss 6 of the 7 phrases on their own (`stable`): "I am going to end my life tonight", "I don't want to be alive anymore", "I can't keep myself safe tonight", "I want to end my life, I have a plan and cannot stay safe.", "I've been cutting myself again", "Nobody would miss me if I were gone". Filed as [rrt-advocate#49](https://github.com/NeuroLift-Technologies/rrt-advocate/issues/49) (coverage) and [rrt-advocate#50](https://github.com/NeuroLift-Technologies/rrt-advocate/issues/50) (developer requests that mention the topic are flagged; a policy question).
- **Foundation routing** never called RRT unless Sleepwalker asked for a handoff, so "I want to die" (RRT alone: emergency / 1.0) was allowed. Fix: [asfdk#41](https://github.com/NeuroLift-Technologies/asfdk/pull/41) (draft; TypeScript and Python). It flips only that one phrase; the other six need #49.
- **Sleepwalker detector** (`NeuroLift-Technologies/sleepwalker`) flags none of the six, and its `safetyConcern` pattern also misses "I dont feel safe" and "I don’t feel safe" (no apostrophe / curly apostrophe). Its whole explicit-crisis vocabulary is six regexes. Filed as [sleepwalker#33](https://github.com/NeuroLift-Technologies/sleepwalker/issues/33) (public repository).
- **Harness `policy.ts`, `protocols.ts`, `tools.ts`:** [asfdk-harness#36](https://github.com/NeuroLift-Technologies/asfdk-harness/pull/36) (merged 2026-11-04; re-synced here from `5488262`): blocks `rm -fr ~`, `rm -rf -- /etc`, `rm -r -f /`, `rm --recursive --force ~`, `cat .en?`, `cat .e*`; the CodeQL file-race fix; path redaction in `asfdk_protocol_status`.  
**Re-sync (2026-11-05):** `policy.ts`, `protocols.ts` and `tools.ts` in `mvp/src/harness/` now match asfdk-harness `5488262` (only the `.ts` import specifiers differ); headers and the harness README carry the new commit. The six `policy.ts` corpus commands moved to the asserted `bashMustBlock` list. Three glob variants raised in review of asfdk-harness#36 were measured as still allowed and are recorded as known gaps: `cat .EN?` (case), `cat cred*.yaml` and `cat .en?.staging` (suffix variants). Not yet filed upstream.  
**Next action:** Owner: asfdk#41 is merged but not yet released, so here still pending is the `@neurolift-technologies/asfdk` bump and moving the "I want to die" corpus entry to asserted; decisions on rrt-advocate#49/#50, sleepwalker#33 and nlt-sdl#13. Then a draft asfdk-harness PR for the three glob variants (owner approval needed: `policy.ts` is escalate-before-change upstream).

### NLTPI-MVP-005 — Coding agent with tools in a Vercel Sandbox
**Status:** step 1 in review (library code, not wired); the rest waits on owner answers  
**Owner:** Joshua W. Dorsey, Sr. / delegated coding agents  
**Summary:** The owner wants the chat page to become a personal coding agent with tools. Options for where tools run were put to the owner; the owner chose **Vercel Sandbox** (2026-11-05). Step 1 adds `mvp/src/sandbox/operations.ts`: sandbox-backed bash/read/write/edit operations behind the harness policy, confined to a workspace root, with no host environment forwarded, timeouts and size caps, tested with a fake sandbox (26 tests; 10 mutation checks each fail the tests). New dependency `@vercel/sandbox` 3.6.1, pinned; 3.7.0 and later are avoided because their transitive `zod@4.1.11` is flagged high by `npm audit`.  
**Plan limit (owner, 2026-11-05):** the free account allows one sandbox. `mvp/src/sandbox/lifecycle.ts` therefore uses one fixed-name persistent sandbox (`nlt-agent`) via `getOrCreate`, one vCPU, deny-all network, a 30-minute default session (40 maximum, under the 45-minute Hobby cap), and a lock so only one turn uses it at a time; a second turn is told it is busy. The Vercel docs I found state higher Hobby limits (10 concurrent sandboxes), so the single-sandbox design satisfies either; the actual limit is unverified until a sandbox is created.  \n**Also in this step:** `mvp/src/gateway/free-models.ts` picks a free model from the live gateway catalog at use time and fails closed (18 tests; checked against the live catalog, which listed 3 selectable models on 2026-11-05).  
**Not done, on purpose:** no route, no sandbox creation, no credentials, no model call. A route that starts sandboxes and runs model-directed commands must not be reachable by anyone with the URL.  
**Open (owner):**
- **Access control.** The owner's answer was "Vercel login for the model provider and model", which can mean the credentials come from the Vercel account (OIDC). That does not restrict who can call the route. Needs a decision: Vercel Authentication for the whole project, a passphrase held in a Vercel environment variable (set by the owner), or something else.
- **Approval defaults.** Proposal: file edits and commands inside the sandbox run without asking; anything that leaves the sandbox (network, git push, exporting files) needs the owner's approval.
- **Egress.** Resolved 2026-11-05: the default is the named allowlist (package registries and GitHub); `deny-all` is one option away; allow-all is available only as an explicit `egressAll: true` (owner: "let allow all as an option", nlt-pi#21).
- **Cost.** Vercel Sandbox usage is billed separately from "free models only"; the owner's plan allowance is not known.
- **Model and agent loop.** A free gateway model (NLTPI-MVP-003) driving the sandbox tools, streamed to the chat page, is step 2. Function duration limits need streaming.  
**Agent runner (2026-11-05, nlt-pi#21):** `mvp/src/agent/runner.ts` composes the crisis gate, free-model choice, the sandbox lock, the sandbox tools and a Pi session, tested offline with the faux provider. Still unwired. Remaining: the route (off by default behind the owner's per-environment flag, `egressAll` only from that flag, effective policy logged), streaming to the chat page, a first real sandbox/gateway run by the owner, and `@vercel/oidc` for the credential.  
**Owner answers (2026-11-05):** egress **allowed**; approvals **yes** (edits and commands inside the sandbox run without asking); **Vercel login added again**.  
**Clarified (2026-11-05):** egress allow-all is available as an explicit option (`egressAll: true`, nlt-pi#21); the default stays the named allowlist. "Approvals yes" means agent turns run in the sandbox and their edits and commands run without extra prompts (the harness policy review still applies to every call).  
- **Egress:** read as "allow outbound access" and implemented as least privilege: package registries (npm, yarn, PyPI) and GitHub by default (`DEFAULT_AGENT_EGRESS`), deny-all one option away. Widening further (for example any domain, or allow-all via `egressAll`) is a separate owner choice.
- **Approvals:** read as agreement with the proposal: no prompts for edits and commands inside the sandbox. Nothing can leave the sandbox with credentials because none are put in it; there is no export or push tool.  
- **Login (verified 2026-11-05):** the owner first turned Vercel Authentication on with deployment type `all_except_custom_domains`; I measured that the primary production domain `nlt-pi-mvp.vercel.app` still answered 200 to anyone. The owner then switched it to **all deployments** (`ssoProtection.deploymentType: all`). Measured after the change: every domain, including production, redirects pages to login (302) and returns 401 for API calls. So the route is no longer reachable by anyone without a Vercel login on any deployment. Protection is a Vercel setting that can be changed later, so the route keeps its own control: it is **off unless the owner sets a flag in Vercel, per environment**, which also decides whether production runs it.  
- **Testing note:** previews are behind login again, so automated checks against a preview from this session get a redirect, not the page.  
**Owner direction (2026-11-05):** "I'll add the vercel login once everything is running." The route is therefore built to ship **off by default**: it refuses to run unless the owner sets a flag in Vercel, so merging code exposes nothing. Turning the flag on before Vercel login is on leaves the route open to anyone with the URL (it can start billed sandboxes); that is the owner's decision to make.  
**Plan:** (1) building blocks, unwired: sandbox operations, free-model selection (this PR); (2) agent runner: Pi session with the sandbox tools and a gateway credential from the Vercel OIDC token; (3) route with streaming, sandbox lifecycle and limits, `vercel.json` duration, chat-page streaming, default off.  
**Next action:** Steps 2 and 3, each as a separate scoped PR (Pi's model layer is file-backed, so wiring a live-catalog free model into a session is its own piece of work; Pi's faux provider allows testing the runner offline). The route must be off by default (flag set by the owner per environment). Owner: set the flag when ready.

### NLTPI-MVP-003 — Provider-agnostic model routing for the governed turn
**Status:** gateway chosen (Vercel AI Gateway); not started  
**Owner:** Joshua W. Dorsey, Sr. / delegated coding agents  
**Summary:** The owner chose provider-agnostic routing through the Vercel AI Gateway on 2026-11-04, so the model provider can be swapped without code changes. `runNltCodingTurn` is not wired to any provider and nothing executes agent turns.  
**Gateway notes (from Vercel documentation, 2026-11-04):** on Vercel deployments the platform supplies an OIDC token automatically, so no stored key is needed there; `AI_GATEWAY_API_KEY` is only for local development and takes precedence over OIDC when set. Per-request provider options include `zeroDataRetention`, `disallowPromptTraining`, `only` (restrict providers) and `models` (fallbacks). These are candidates for prompts that may contain crisis content; none are configured.  
**Model policy (owner decision, 2026-11-04):** only free models are allowed through the gateway. The gateway's public catalog (`GET https://ai-gateway.vercel.sh/v1/models`, no authentication) lists per-token prices, so "free" can be checked from data and not from a hand-kept list. Measured the same day: 4 of 320 language models were listed at zero input and output price, and one of them was flagged `varies_by_provider`, so a zero price is not guaranteed on every provider. Implementation must therefore (1) read the catalog, (2) allow only models with zero input and output price that are not `varies_by_provider`, (3) fail closed (refuse the turn) when the catalog cannot be read or the chosen model is not on that list, and (4) not hard-code model identifiers in source. The catalog changes, so the check must run at use time. Free models can have weaker data-handling terms; this is why the retention question below stays open.  
**Open before implementation:** whether to require zero-data-retention and no-training for every request (and whether any free model can satisfy it); how `runNltCodingTurn` is exposed (it must stay behind the ASFDK harness and an authenticated session; nothing in this MVP is authenticated yet).  
**Next action:** Owner to decide the retention settings; then a separate scoped PR.

### NLTPI-MVP-001 — NLT Coding Agent MVP scaffold
**Status:** scaffolded; workspace integration and validation wiring added on PR branch  
**Owner:** Joshua W. Dorsey, Sr. / delegated coding agents  
**Summary:** Created an isolated `mvp/` TypeScript application boundary consuming the checked-in `packages/coding-agent` workspace. Root npm workspace/lockfile wiring and an explicit MVP typecheck in repository validation are included. Runtime composition and Vercel deployment are not implemented.  
**PR:** https://github.com/NeuroLift-Technologies/nlt-pi/pull/8  
**Branch:** `feat/mvp-coding-agent-scaffold`  
**Verification:** Connector-only edits; npm install, lockfile validation, build, typecheck, and tests have not been run locally. PR CI must verify the generated-equivalent lockfile and checks.  
**Next action:** Verify PR CI, then review Vercel monorepo source inclusion and select the framework before governed runtime composition.

### NLTPI-GOV-002 — Align repository implementation with public governance baseline
**Status:** in_review  
**Owner:** Joshua W. Dorsey, Sr. / delegated coding agents  
**Summary:** Align NLT-Pi's repository-specific governance implementation with the minimum requirements and reusable templates in the public NeuroLift-Technologies/.github repository. Correct template provenance, provide local public-baseline governance documents and links, remove inherited upstream Pi contributor restrictions from issue templates, improve registration/handoff evidence states, and validate the baseline locally. The public templates are minimum requirements; NLT-Pi retains justified architecture-specific controls.  
**PR:** https://github.com/NeuroLift-Technologies/nlt-pi/pull/7  
**Branch:** `fix/public-governance-baseline-alignment`  
**Agent registration:** `docs/agent-log/registrations/2026-11-01-chatgpt-gpt6-governance.json`  
**Intent record:** `docs/agent-log/intent/2026-11-01-public-governance-alignment.md`  
**Verification:** GitHub Actions governance workflow run [#47](https://github.com/NeuroLift-Technologies/nlt-pi/actions/runs/41385024000) completed successfully. Both the repository governance validator and its Node test passed. General repository CI run [#41](https://github.com/NeuroLift-Technologies/nlt-pi/actions/runs/41385024202) is still in progress.  
**Next action:** Inspect general CI run #41, review the PR, and merge only after human approval.

### NLTPI-SEC-001 — Align security policy with NLT governance
**Status:** in_review  
**Owner:** Joshua W. Dorsey, Sr. / delegated coding agents  
**Summary:** Replace inherited Pi/Earendil-specific security guidance with an NLT-Pi policy. The update preserves the local execution/no-OS-sandbox warning while defining NLT's development, ASFDK foundation, harness, MCP, and AgentOS trust boundaries; enforcement-first requirements; prompt-injection criteria based on demonstrated impact; vulnerability scope; private reporting; and incident handling. Disclosure routing now matches the organization's `NeuroLift-Technologies/.github/SECURITY.md`: `admin@neuroliftsolutions.com` and GitHub Private Vulnerability Reporting. If neither private channel is available, stop and obtain an alternative established private route; never fall back to a public issue.  
**PR:** https://github.com/NeuroLift-Technologies/nlt-pi/pull/6  
**Related escalation:** https://github.com/NeuroLift-Technologies/nlt-pi/issues/5 (PR #6 addresses item 1 only; branch protection and CI startup failures remain outstanding).  
**Branch:** `docs/nlt-pi-security-policy`  
**Verification:** Documentation-only change. No runtime tests were run. The organizational email route is verified from the organization-level SECURITY.md; enablement of repository-level GitHub Private Vulnerability Reporting remains unverified.  
**Next action:** Owner to review policy wording and verify repository-level GitHub Private Vulnerability Reporting is enabled. The organization-established email route is included. Separately resolve main branch protection and Actions startup failures tracked in Issue #5.

### NLTPI-ARCH-001 — ASFDK three-layer governance alignment
**Status:** active  
**Owner:** Joshua W. Dorsey, Sr.  
**Summary:** Maintain explicit separation between development governance, ASFDK foundation, and ASFDK MCP integration governance.  
**Next action:** Keep repository documentation and agent profiles consistent with the actual package/runtime boundaries; do not infer enforcement from documentation alone.

## Resolved

### NLTPI-CONTRIB-001 — Remove repository-local contributor gate
**Status:** resolved  
**Owner:** Joshua W. Dorsey, Sr. / delegated coding agents  
**Summary:** Removed the inherited contributor auto-close/approval workflows and allowlist in the requested order, then removed local CONTRIBUTING.md so the organization-level default applies.  
**PR:** https://github.com/NeuroLift-Technologies/nlt-pi/pull/4  
**Resolution:** PR #4 merged to `main` on 2026-11-02. Branch protection and the two requested repository settings remain separate outstanding administrative work.

### NLTPI-GOV-001 — Repository governance adoption
**Status:** resolved  
**Owner:** Joshua W. Dorsey, Sr. / delegated coding agents  
**Summary:** Adapted the public NLT governance baseline to NLT-Pi, including repository-specific OTOI, agent instructions, review and handoff artifacts, agent profiles, Claude Code configuration, and validation.  
**PR:** https://github.com/NeuroLift-Technologies/nlt-pi/pull/3  
**Resolution:** PR #3 merged to `main`.
