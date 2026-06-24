---
description: Update a GitHub security advisory for publication
argument-hint: "<advisory-url-or-draft-path>"
---
Update a GitHub security advisory for publication: $ARGUMENTS

Use `gh` for all GitHub operations. Do not publish the advisory, change its state, or request a CVE unless the user explicitly agrees or the draft markdown explicitly says `request_cve: true`.

GitHub does not expose repository security advisory comments/discussion through the documented REST OpenAPI schema or public GraphQL schema. A 404 from guessed API endpoints such as `api.github.com/repos/.../security-advisories/<GHSA>/comments`, `.../timeline`, or `.../events` is expected and is not, by itself, an auth failure. Do not use a browser session, browser cookies, or cookie extraction to fetch advisory comments. Instead, clearly tell the user that advisory comments were not included and that they can paste any relevant comments if they want them considered.

## Input handling

- If `$ARGUMENTS` is a GitHub security advisory URL, start the investigation and drafting workflow.
- If `$ARGUMENTS` is a path to an existing markdown draft, read it and apply that draft to the advisory.
- In a follow-up message after this prompt, if the user says "update", "apply", "looks good", or similar, treat it as approval to apply the previously written temp markdown draft. Re-read the file from disk before updating GitHub.
- If applying a draft and there is no known draft path, ask the user for the markdown file path.

## Initial advisory workflow

1. Parse the advisory URL into `owner`, `repo`, and `GHSA` id.
2. Fetch the advisory with:
   ```sh
   gh api repos/<owner>/<repo>/security-advisories/<GHSA>
   ```
   Record the advisory's original severity, CVSS vector, and CVSS score exactly as returned before proposing changes.
3. Do not fetch advisory comments/discussion unless the user pasted them into the conversation:
   - Inspect the advisory JSON for references, credits, linked issues/PRs, and any discussion fields.
   - Do not rely on invented API endpoints such as `/comments`, `/timeline`, or `/events`; they commonly return 404 because GitHub does not expose draft advisory comments through the public API.
   - Do not use a browser session, browser cookies, or cookie extraction to fetch comments.
   - Explicitly tell the user: `Advisory comments were not included because GitHub does not expose them through the public API. Paste any relevant comments if you want them considered.`
   - If the user pasted comments, read and consider them.
   - Never pretend comments were read.
4. Investigate independently:
   - Read the advisory text, metadata, affected package(s), version ranges, CVSS, CWE, references, and linked issues/PRs/commits.
   - Inspect relevant code history, releases, changelogs, package metadata, and tags.
   - Determine whether the vulnerability is already fixed.
   - If fixed, identify the patched version(s) and the correct affected version range.
   - Do not trust the reporter's analysis without verification.
5. Discuss CVSS with the user before drafting the final update:
   - Propose a CVSS vector, score, and severity.
   - Explain the controversial metrics briefly.
   - Ask the user to confirm or adjust it.
6. Ask whether a CVE should be requested from GitHub for this advisory.
7. Draft a publication-ready advisory markdown file under `/tmp`, for example `/tmp/sa-<GHSA>.md`. Include both the original CVSS from the advisory and the proposed/confirmed updated CVSS.
8. Tell the user:
   - the path to the temp markdown file
   - the original advisory URL
   - that they can edit the file and then say "update" or provide the path

## Draft markdown format

The draft file must contain YAML frontmatter followed by the advisory body. Include all fields needed to update GitHub and to decide whether to request a CVE.

```markdown
---
advisory_url: https://github.com/<owner>/<repo>/security/advisories/<GHSA>
owner: <owner>
repo: <repo>
ghsa_id: <GHSA>
summary: <short advisory summary>
original_severity: <low|medium|high|critical|null>
original_cvss_vector: <original CVSS:3.1/... or null>
original_cvss_score: <original number or null>
severity: <proposed/confirmed low|medium|high|critical>
cvss_vector: <proposed/confirmed CVSS:3.1/...>
cvss_score: <proposed/confirmed number>
cwe_ids:
  - CWE-...
vulnerabilities:
  - package:
      ecosystem: npm
      name: <package-name>
    vulnerable_version_range: <range>
    patched_versions: <range-or-version>
request_cve: false
---

# <Advisory title>

<Concise description of the vulnerability and vulnerable behavior.>

## Info

<Technical explanation of the root cause and affected component. Focus on facts needed by defenders and maintainers. Do not include PoC steps, exploit payloads, or copy-pastable exploit strings.>

## Impact

<Who can exploit it, prerequisites, confidentiality/integrity/availability impact, and realistic deployment assumptions.>

## Affected versions

- Affected: `<range>`
- Patched: `<version or range>`

## The solution

<Describe the fix and the patched release.>

## Recommendations

<Upgrade guidance and operational mitigations.>

## Workarounds

<Workarounds if any; otherwise skip this section entirely>

## Timeline

- YYYY-MM-DD: Report received
- YYYY-MM-DD: Fix committed
- YYYY-MM-DD: Fixed version released
- YYYY-MM-DD: Advisory published

## Credits

<Reporter/researcher attribution if appropriate, otherwise skip section.>

## References

- <links to releases, commits, advisories, documentation>
```

Use the curl advisory style as inspiration: clear sections, direct language, affected/fixed version facts, recommendations, timeline, and credits. Do not include a PoC.

## Applying a draft to GitHub

When the user approves with "update"/similar or provides a markdown path:

1. Re-read the markdown file from disk. Never rely on the previously generated content in memory.
2. Parse the YAML frontmatter and body.
3. Build a JSON payload in a temporary file. Map fields as follows:
   - `summary` from frontmatter
   - `description` from the markdown body after frontmatter
   - `severity` from frontmatter if present
   - `cvss_vector_string` from `cvss_vector`
   - `cwe_ids` from frontmatter
   - `vulnerabilities` from frontmatter
   - Do not send `original_severity`, `original_cvss_vector`, or `original_cvss_score`; those fields are retained only for audit context.
4. Update the advisory with:
   ```sh
   gh api -X PATCH repos/<owner>/<repo>/security-advisories/<GHSA> --input /tmp/<payload>.json
   ```
5. If and only if the markdown frontmatter has `request_cve: true`, request a CVE with:
   ```sh
   gh api -X POST repos/<owner>/<repo>/security-advisories/<GHSA>/cve
   ```
   Treat "already requested" or "already assigned" as non-fatal and report it.
6. Report what was updated:
   - advisory URL
   - summary
   - affected range
   - patched versions
   - original CVSS vector/score/severity
   - updated CVSS vector/score/severity
   - whether CVE was requested

## Safety rules

- Do not include PoC material in the final advisory body.
- Do not request a CVE unless `request_cve: true` is present in the markdown file.
- Do not publish the advisory or change its state unless the user explicitly asks.
- Do not fetch advisory comments through browser sessions or cookies. State that comments were not included and invite the user to paste relevant comments if they want them considered.
- If there is uncertainty in affected ranges, patched versions, CVSS, or CVE request status, ask the user before applying.
