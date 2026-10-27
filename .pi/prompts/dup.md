---
description: Find potential duplicates of a GitHub issue
argument-hint: "<issue-url>"
---
Look for potential duplicates of this issue in its GitHub repo: $1

Steps:
1. Read the issue with `gh issue view <url> --comments` to understand the problem.
2. Search open and closed issues and PRs in the same repo with `gh search issues` / `gh issue list --search` / `gh pr list --search`, using several keyword variations (error messages, feature names, affected components, symptoms).
3. Read promising candidates to confirm they describe the same problem, not just similar words.

A duplicate reports the same problem or requests the same change: same symptom with the same likely cause, or a PR that fixes this exact issue. Sharing a component, an error message, or a related cause is not enough.

Output a short draft GitHub comment with a writte by AI disclosure.

If there are none, reply "No duplicates found."

Do not post, label, or close anything.
