---
description: Analyze GitHub issues (bugs or feature requests)
argument-hint: "<issue>"
---
Analyze GitHub issue(s): $ARGUMENTS

For each issue:

1. Add the `inprogress` label to the issue via GitHub CLI before analysis starts. If adding the label fails, report that explicitly and continue.
2. Read the issue in full, including all comments and linked issues/PRs.
3. Do not trust analysis written in the issue. Independently verify behavior and derive your own analysis from the code and execution path.

4. **For bugs**:
   - Ignore any root cause analysis in the issue (likely wrong)
   - Read all related code files in full (no truncation)
   - Trace the code path and identify the actual root cause
   - Propose a fix

5. **For feature requests**:
   - Do not trust implementation proposals in the issue without verification
   - Read all related code files in full (no truncation)
   - Propose the most concise implementation approach
   - List affected files and changes needed

Do NOT implement unless explicitly asked. Analyze and propose only.
