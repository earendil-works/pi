# Active Threads — NLT-Pi

**Last updated:** 2026-11-04

## Active

### NLTPI-MVP-002 — Vendor ASFDK harness into the MVP and test on Vercel
**Status:** in_review (draft PR); Vercel endpoint verification pending  
**Owner:** Joshua W. Dorsey, Sr. / delegated coding agents  
**Summary:** The MVP imported an unpublished, undeclared `@neurolift-technologies/asfdk-harness` package, so it could not typecheck. The needed subset of `asfdk-harness` `src/` (commit `f28136d`) is now vendored under `mvp/src/harness/` with provenance headers; dependencies are declared and pinned. Testing against the real foundation found that the governed-turn crisis gate could never block (runtime level values vs. enum member names, and risk flags read at the wrong depth); it is fixed in `mvp/src/gate.ts` with tests, and fails closed when the assessment is unavailable. A preview-only `POST /api/govern` (404 in production, `executionEnabled: false`) was added as the Vercel test surface.  
**PR:** https://github.com/NeuroLift-Technologies/nlt-pi/pull/15  
**Branch:** `ccr-0d5033af-1rkbla`  
**Registration:** `docs/agent-log/registrations/2026-11-04T191617Z-claude-code-01UNjnjm3TZ7Tg4MRswGt24P.json`  
**Intent record:** `docs/agent-log/intent/2026-11-04-vendor-asfdk-harness-into-mvp.md`  
**Handoff:** `docs/agent-log/handoffs/2026-11-04-vendor-asfdk-harness-into-mvp.json`  
**Verification:** MVP typecheck, MVP tests (7 node + 19 vitest), pinned-deps, runtime-deps, ts-imports, entry-graphs, install-lock, biome, and the governance validator passed locally in the cloud container. The full root `npm run check` and root tests were not run. A Vercel preview (`dpl_FpQAQSotFRZkqrFwgE5PeHUBakHv`) built and reached READY, but `/api/govern` has not been invoked on it. Its build log showed `error TS2688: Cannot find type definition file for 'node'` (from `types: ["node"]` in `mvp/tsconfig.json`); fixed in `b018928` by moving that option to `tsconfig.typecheck.json`, and the build of that commit logs no TS error.  
**CI:** At the owner's direction the inherited Pi-fork `.github/workflows/ci.yml` was removed (it failed on `main` for the last five runs). The dependent `preview-packages.yml` workflow and its script/test (`scripts/preview-packages.mjs`, `.test.mjs`) were also removed at the owner's direction. The remaining inherited Pi workflows (`build-binaries`, `issue-analysis`, `issue-triage-labels`, `nix`, `npm-audit`, `publish-model-catalog`, `remove-inprogress-on-close`) were also removed at the owner's direction; only `validate-nlt-governance.yml` remains. Docs and scripts that mentioned them (`.pi/skills/release.md`, `scripts/build-binaries.sh`, `.pi/extensions/import-repro.ts`, the mcp-conformance README) were updated. The four open decisions (vendored copy, RRT detector gaps, prompt channel, model provider) are deferred until PR #15 is merged, at the owner's direction.  
**Blockers / known issues:** Upstream RRT detector (keyword prototype) misses some phrasings (for example "I want to end my life, I have a plan and cannot stay safe"); crisis logic changes are escalate-only. `mvp/package.json` `engines` (`>=22.19.0`) makes Vercel select Node 26.x.  
**Decisions needed:** Keep the vendored copy vs. a published or workspace package; handling of the RRT detector gaps; whether the prompt channel should be trusted `USER_INPUT`; model provider selection before `runNltCodingTurn` is run.  
**Next action:** Invoke `POST /api/govern` on the preview (authorized browser or share link) and confirm allow/block behavior; owner review of PR #15.

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
