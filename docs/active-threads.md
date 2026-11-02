# Active Threads — NLT-Pi

**Last updated:** 2026-11-02

## Active

### NLTPI-CONTRIB-001 — Remove repository-local contributor gate
**Status:** in_review  
**Owner:** Joshua W. Dorsey, Sr. / delegated coding agents  
**Summary:** Remove the fork-inherited contributor auto-close/approval mechanism from NLT-Pi so normal GitHub contribution behavior applies. Deleted the PR Gate, Issue Gate, and Approve Contributor workflows first, then their `.github/APPROVED_CONTRIBUTORS` data file, then the local `CONTRIBUTING.md` so GitHub can surface the organization-level default guide from `NeuroLift-Technologies/.github`.  
**Branch:** `governance/remove-contributor-gates`  
**Next action:** Confirm the two requested repository settings and verify that `main` requires approving review(s) and required status checks. Branch-protection read currently returns HTTP 403 for this integration; do not infer protection from the branch's `protected` flag alone.

### NLTPI-ARCH-001 — ASFDK three-layer governance alignment
**Status:** active  
**Owner:** Joshua W. Dorsey, Sr.  
**Summary:** Maintain explicit separation between development governance, ASFDK harness enforcement, and ASFDK MCP integration governance.  
**Next action:** Keep repository documentation and agent profiles consistent with the actual package/runtime boundaries; do not infer enforcement from documentation alone.

## Resolved

### NLTPI-GOV-001 — Repository governance adoption
**Status:** resolved  
**Owner:** Joshua W. Dorsey, Sr. / delegated coding agents  
**Summary:** Adapted the canonical NLT governance stack to NLT-Pi, including repository-specific OTOI, agent instructions, review and handoff artifacts, agent profiles, Claude Code configuration, and validation.  
**PR:** https://github.com/NeuroLift-Technologies/nlt-pi/pull/3  
**Resolution:** PR #3 merged to `main`. Follow-on contributor-gate removal is tracked separately as NLTPI-CONTRIB-001.
