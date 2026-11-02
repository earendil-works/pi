# Active Threads — NLT-Pi

**Last updated:** 2026-11-02

## Active

### NLTPI-MVP-001 — NLT Coding Agent MVP scaffold
**Status:** scaffolded  
**Owner:** Joshua W. Dorsey, Sr. / delegated coding agents  
**Summary:** Created an isolated `mvp/` TypeScript application boundary consuming `@earendil-works/pi-coding-agent`. Runtime composition and Vercel deployment are not implemented.  
**PR:** pending  
**Branch:** `feat/mvp-coding-agent-scaffold`  
**Verification:** Not run; no local checkout or package installation was available.  
**Next action:** Review scaffold, select Vercel framework, and implement governed runtime composition.

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
