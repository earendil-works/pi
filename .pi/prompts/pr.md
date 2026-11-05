---
description: Review PRs from URLs with structured issue and code analysis
argument-hint: "<PR-URL>"
---
You are given one or more GitHub PR URLs: $@

For each PR URL, do the following in order:
1. Add the `inprogress` label to the PR via GitHub CLI before analysis starts. If adding the label fails, report that explicitly and continue.
2. Read the PR page in full. Include description, all comments, all commits, and all changed files.
3. Identify any linked issues referenced in the PR body, comments, commit messages, or cross links. Read each issue in full, including all comments.
4. Analyze the PR diff without checking out or switching to the PR branch. Use `gh pr diff`, `gh pr view`, `gh api`, and local main-branch files; if PR file contents are needed, use fetched refs with `git show <ref>:<path>` or temporary files. Read all relevant code files in full with no truncation and compare against the diff. Do not fetch PR file blobs unless a file is missing on main or the diff context is insufficient. Include related code paths that are not in the diff but are required to validate behavior.
5. Do not check for a changelog entry. Per CONTRIBUTING.md, contributor PRs must not edit `CHANGELOG.md` — the maintainer adds the entry when merging.
6. Check if packages/coding-agent/README.md, packages/coding-agent/docs/*.md, packages/coding-agent/examples/**/*.md require modification. This is usually the case when existing features have been changed, or new features have been added.
7. Provide a structured review that follows this repository's own review standard, `REVIEW.md` (governed by NLT-PI-DEV-OTOI-1.0.1, organizational baseline ORG-DEV-OTOI-1.0.4), not the generic section set above. Use its required sections and output format:

   - Review metadata: reviewer, date, review type, scope, local contract, organizational baseline.
   - Pre-review checklist.
   - Summary: concise assessment and overall risk.
   - Findings: Critical and High as tables (location, finding, scenario, impact, required remediation); Medium / Low as list items (location, finding, scenario, impact, required remediation). If no findings exist, state none identified under Critical and High.
   - Architecture and governance checklist.
   - Verification: exact commands and outcomes; mark tests as not run when not run; separate static inspection from executed tests.
   - Verdict: status (`APPROVED | CHANGES REQUESTED | BLOCKED`) and rationale.
   - Handoff: completed, remaining, blockers, decisions required, next action.

Output format per PR:
PR: <url>
Review metadata:
- ...
Pre-review checklist:
- ...
Summary:
- ...
Findings:
- Critical:
- High:
- Medium / Low:
Architecture and governance:
- ...
Verification:
- ...
Verdict:
- Status:
- Rationale:
Handoff:
- ...

If no findings are identified, say so under Critical and High.
