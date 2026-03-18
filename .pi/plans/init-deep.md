# init-deep — Hierarchical AGENTS.md Update

## TL;DR
> **Quick Summary**: Update 10 existing AGENTS.md files (fix 2 with confirmed inaccuracies, verify 8 others), create 2 new AGENTS.md for high-complexity subdirectories.
> **Deliverables**: 12 accurate, non-redundant, telegraphic AGENTS.md files forming a clean hierarchy
> **Estimated Effort**: Short (mostly verification + 2 small new files)
> **Parallel Execution**: YES — 2 waves
> **Critical Path**: Wave 1 (all fixes/creates/verifies in parallel) → Wave 2 (dedup review)

## Context

### Original Request
`/init-deep` (update mode — no `--create-new` flag). Generate hierarchical AGENTS.md files: root + complexity-scored subdirectories.

### State Machine Assessment
No stateful workflows identified — skipped. This is a documentation generation task (static file writes).

### Memory Recall
Memory store unavailable. No prior project context or cross-project learnings retrieved.

### Metis Review
Metis consultation returned minimal output. The following guardrails are self-derived from the `/init-deep` spec and discovery findings:

**Guardrails applied:**
- Update mode: NEVER delete existing AGENTS.md files
- Child NEVER repeats parent content
- Root size waiver: 280 lines justified (critical dev rules, release process, git safety)
- Telegraphic only — no prose, no generic advice
- Edit existing files; Write only for new files
- Verify all file references before generating content

**Assumptions validated:**
- All 10 existing AGENTS.md files confirmed readable
- `pipe/` dir confirmed missing from `coding-agent/src/modes/` (only `interactive/`, `print-mode.ts`, `rpc/`)
- `context.ts` confirmed missing from `ai/src/` (Context type lives in `types.ts`)
- `docs/` dir confirmed EXISTS in `coding-agent/` (24 docs files — extensions, keybindings, themes, sdk, etc.)
- Scoring formula applied consistently: File count (3x) + Subdir count (2x) + Code ratio (2x) + Unique patterns (1x) + Module boundary (2x) + Symbol density (2x) + Export count (2x)

---

## Work Objectives

### Core Objective
Bring all AGENTS.md files to accurate, non-redundant state and add new ones where directory complexity warrants.

### Concrete Deliverables
1. 2 existing AGENTS.md files fixed (confirmed inaccuracies)
2. 8 existing AGENTS.md files verified (edit only if inaccurate)
3. 2 new AGENTS.md files created for high-score directories
4. 1 deduplication review pass

### Definition of Done
- Every file path referenced in any AGENTS.md exists on disk
- No child AGENTS.md repeats content from its parent
- All files within size limits (root: ≤300 lines waived, subdirs: 30-80 lines)
- Zero generic advice (nothing that applies to ALL TypeScript projects)

### Must Have
- Fix `coding-agent/AGENTS.md`: remove `pipe/` reference; add `print-mode.ts`, `rpc/`
- Fix `ai/AGENTS.md`: remove stale `context.ts`; add missing files (`api-registry.ts`, `bedrock-provider.ts`, `cli.ts`, `env-api-keys.ts`, `oauth.ts`)
- New `coding-agent/examples/extensions/AGENTS.md`
- New `coding-agent/src/modes/interactive/AGENTS.md`

### Must NOT Have (Guardrails)
- Do NOT delete any existing AGENTS.md file
- Do NOT rewrite files for style — preserve existing voice/formatting
- Do NOT add AGENTS.md to directories scoring <8 (tools/, extensions/, compaction/, utils/, components/)
- Do NOT trim root AGENTS.md below current size — dev rules are critical
- Do NOT include generic TypeScript advice in any file
- Do NOT use `Write` tool on files that already exist — use `Edit` only

---

## Verification Strategy

### Test Decision
No automated tests — this is documentation. Verification is structural: file existence checks + content audits.

### QA Policy
Each TODO has QA scenarios. All are executable by an agent using `ls`, `read`, `grep` tools.

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — ALL parallel, 12 tasks):
├── TODO 1:  Fix coding-agent/AGENTS.md (confirmed bugs)
├── TODO 2:  Fix ai/AGENTS.md (confirmed bugs)
├── TODO 3:  Create examples/extensions/AGENTS.md
├── TODO 4:  Create modes/interactive/AGENTS.md
├── TODO 5:  Verify packages/agent/AGENTS.md
├── TODO 6:  Verify packages/ai/src/providers/AGENTS.md
├── TODO 7:  Verify packages/coding-agent/src/core/AGENTS.md
├── TODO 8:  Verify packages/mom/AGENTS.md
├── TODO 9:  Verify packages/pods/AGENTS.md
├── TODO 10: Verify packages/tui/AGENTS.md
├── TODO 11: Verify packages/web-ui/AGENTS.md
└── TODO 12: Verify root ./AGENTS.md

Wave 2 (After Wave 1 — final review):
└── TODO 13: Deduplication + hierarchy review
```

### Dependency Matrix

| Task | Blocks | Blocked By |
|------|--------|------------|
| TODO 1 | TODO 13 | None |
| TODO 2 | TODO 13 | None |
| TODO 3 | TODO 13 | None |
| TODO 4 | TODO 13 | None |
| TODO 5 | TODO 13 | None |
| TODO 6 | TODO 13 | None |
| TODO 7 | TODO 13 | None |
| TODO 8 | TODO 13 | None |
| TODO 9 | TODO 13 | None |
| TODO 10 | TODO 13 | None |
| TODO 11 | TODO 13 | None |
| TODO 12 | TODO 13 | None |
| TODO 13 | None | TODO 1-12 |

---

## TODOs

- [ ] 1. Fix coding-agent/AGENTS.md — remove stale pipe/ reference
  **What to do**:
    1. Read `packages/coding-agent/AGENTS.md` in full
    2. Read `packages/coding-agent/src/modes/print-mode.ts` lines 1-15 for description
    3. Read `packages/coding-agent/src/modes/rpc/rpc-mode.ts` lines 1-15 for description
    4. Edit Structure section: replace `pipe/  # Non-interactive JSON mode (--mode json)` with `print-mode.ts  # Non-interactive streaming output mode` and add `rpc/  # JSON-RPC mode for programmatic access`
    5. Edit Where to Look table: replace `Pipe/JSON mode | src/modes/pipe/` with `Print mode | src/modes/print-mode.ts` and add `RPC mode | src/modes/rpc/`
    6. Verify remaining entries still accurate (including `docs/` — it exists with 24 files)
  **Must NOT do**:
    - Do not rewrite sections that are already accurate
    - Do not change the file's voice or formatting style
    - Do not add content from parent root AGENTS.md
    - Do NOT remove the `docs/` reference — `packages/coding-agent/docs/` exists (24 doc files)
  **Parallelization**:
    - Can Run In Parallel: YES
    - Parallel Group: Wave 1
    - Blocks: TODO 13
    - Blocked By: None
  **References**:
    - `packages/coding-agent/AGENTS.md` (structure section with pipe/ reference around line 12)
    - `packages/coding-agent/AGENTS.md` (Where to Look table pipe/ row around line 24)
    - `packages/coding-agent/src/modes/` (actual contents: `interactive/`, `print-mode.ts`, `rpc/`, `index.ts`)
    - `packages/coding-agent/docs/` (EXISTS — 24 files including extensions.md, sdk.md, keybindings.md, etc.)
  **Acceptance Criteria**:
    - `grep "pipe/" packages/coding-agent/AGENTS.md` returns zero matches
    - `grep "print-mode" packages/coding-agent/AGENTS.md` returns at least 1 match
    - `grep "rpc/" packages/coding-agent/AGENTS.md` returns at least 1 match
    - `grep "docs/" packages/coding-agent/AGENTS.md` returns at least 1 match (preserved, NOT removed)
    - File is 25-40 lines
  **QA Scenarios**:
    Scenario: Structure section accuracy
      Tool: Bash
      Steps: For each path listed in the Structure section of `packages/coding-agent/AGENTS.md`, verify it exists with `ls packages/coding-agent/<path>` (use src/ prefix for src entries, no prefix for top-level entries like examples/, docs/)
      Expected Result: Every listed path resolves to an existing file or directory
    Scenario: Where to Look table accuracy
      Tool: Bash
      Steps: For each file path in the Where to Look table, run `ls packages/coding-agent/<path>`
      Expected Result: Every referenced file exists

- [ ] 2. Fix ai/AGENTS.md — remove stale context.ts, add missing files
  **What to do**:
    1. Read `packages/ai/AGENTS.md` in full
    2. Run `ls packages/ai/src/` to get current file listing
    3. Edit Structure section: remove `context.ts  # Context/token management, message truncation`
    4. Edit Structure section: add missing top-level files that an agent needs to know about:
       - `api-registry.ts  # Provider registration and lookup`
       - `bedrock-provider.ts  # Bedrock provider entry point`
       - `cli.ts  # CLI interface for ai package`
       - `env-api-keys.ts  # Environment variable API key detection (NEVER top-level imports)`
       - `oauth.ts  # OAuth flow orchestration`
       - `models.generated.ts  # Auto-generated model catalog (NEVER edit manually)`
    5. Read each file's first 5-10 lines to confirm the one-line descriptions are accurate
    6. Verify Where to Look table and Anti-Patterns section still accurate
  **Must NOT do**:
    - Do not change anti-patterns section (it's accurate)
    - Do not change Commands section
    - Do not add generic TypeScript advice
    - Do not exceed 50 lines total
  **Parallelization**:
    - Can Run In Parallel: YES
    - Parallel Group: Wave 1
    - Blocks: TODO 13
    - Blocked By: None
  **References**:
    - `packages/ai/AGENTS.md` (line 8: `context.ts` stale reference in structure)
    - `packages/ai/src/` (actual files: api-registry.ts, bedrock-provider.ts, cli.ts, env-api-keys.ts, index.ts, models.generated.ts, models.ts, oauth.ts, providers/, stream.ts, types.ts, utils/)
  **Acceptance Criteria**:
    - `grep "context.ts" packages/ai/AGENTS.md` returns zero matches
    - `grep "api-registry" packages/ai/AGENTS.md` returns at least 1 match
    - `grep "env-api-keys" packages/ai/AGENTS.md` returns at least 1 match
    - Every file path in the Structure section exists in `packages/ai/src/`
    - File is 30-50 lines
  **QA Scenarios**:
    Scenario: All structure entries exist
      Tool: Bash
      Steps: Extract every filename from the Structure code block. For each, run `ls packages/ai/src/<name>`
      Expected Result: All resolve. Zero stale references.
    Scenario: No missing major files
      Tool: Bash
      Steps: Run `ls packages/ai/src/*.ts` and diff against filenames in AGENTS.md Structure section
      Expected Result: Every non-generated, non-index .ts file in src/ is listed (or explicitly omitted with reason)

- [ ] 3. Create coding-agent/examples/extensions/AGENTS.md
  **What to do**:
    1. Read `packages/coding-agent/examples/README.md` for context
    2. Read 5 representative extensions to understand patterns:
       - `packages/coding-agent/examples/extensions/hello.ts` (simplest)
       - `packages/coding-agent/examples/extensions/tools.ts` (custom tools)
       - `packages/coding-agent/examples/extensions/commands.ts` (slash commands)
       - `packages/coding-agent/examples/extensions/subagent/index.ts` (multi-file)
       - `packages/coding-agent/examples/extensions/plan-mode/index.ts` (complex)
    3. Read first 10 lines of 3-4 more to spot patterns
    4. Write new file with sections:
       - `# examples/extensions — Extension Examples` (1-line overview)
       - CATEGORIES: Group the 50+ extensions by capability (tools, UI, hooks, providers, etc.)
       - WHERE TO LOOK: Task → example file mapping
       - PATTERN: Extension entry point signature, single-file vs multi-file distinction
       - ANTI-PATTERNS: What NOT to do (from parent + code comments)
    5. Verify file is 40-70 lines, telegraphic, no parent duplication
  **Must NOT do**:
    - Do NOT list every single extension file (there are 50+) — categorize instead
    - Do NOT repeat extension system docs from `coding-agent/src/core/AGENTS.md`
    - Do NOT repeat anti-patterns already in parent `coding-agent/AGENTS.md`
    - Do NOT include build/test commands (examples aren't tested separately)
    - Do NOT use Write tool if file already exists — check first with `ls`
  **Parallelization**:
    - Can Run In Parallel: YES
    - Parallel Group: Wave 1
    - Blocks: TODO 13
    - Blocked By: None
  **References**:
    - `packages/coding-agent/examples/extensions/` (50+ files, 8 subdirectories)
    - `packages/coding-agent/examples/README.md` (context)
    - `packages/coding-agent/AGENTS.md` (parent — do NOT duplicate)
    - `packages/coding-agent/src/core/AGENTS.md` (do NOT duplicate extension system docs)
  **Acceptance Criteria**:
    - File exists at `packages/coding-agent/examples/extensions/AGENTS.md`
    - File is 40-70 lines
    - `grep "pipe/" packages/coding-agent/examples/extensions/AGENTS.md` returns zero (no stale refs)
    - Contains at least 3 extension categories
    - Contains a WHERE TO LOOK section with at least 5 task→file mappings
    - Zero overlap with `packages/coding-agent/AGENTS.md` content (checked in TODO 13)
  **QA Scenarios**:
    Scenario: Referenced example files exist
      Tool: Bash
      Steps: Extract every file path mentioned in the new AGENTS.md. For each, run `ls packages/coding-agent/examples/extensions/<path>`
      Expected Result: All referenced files exist
    Scenario: No parent duplication
      Tool: Read
      Steps: Read both `packages/coding-agent/AGENTS.md` and the new file. Compare content.
      Expected Result: No sentences or table rows appear in both files

- [ ] 4. Create coding-agent/src/modes/interactive/AGENTS.md
  **What to do**:
    1. Read `packages/coding-agent/src/modes/interactive/interactive-mode.ts` lines 1-50
    2. Read `packages/coding-agent/src/modes/interactive/components/index.ts` for exports list
    3. Read `packages/coding-agent/src/modes/interactive/theme/theme.ts` lines 1-30
    4. Scan 3-4 representative components (assistant-message.ts, tool-execution.ts, footer.ts, model-selector.ts) first 20 lines each
    5. Write new file with sections:
       - `# interactive — TUI Interactive Mode` (1-line overview)
       - STRUCTURE: `interactive-mode.ts`, `components/` (35 files), `theme/`
       - WHERE TO LOOK: Task → file mapping for common TUI changes
       - CONVENTIONS: Component pattern, keybinding rules, import from components/index.ts
    6. Verify 30-60 lines, telegraphic, no parent duplication
  **Must NOT do**:
    - Do NOT list all 35 component files individually — group by function
    - Do NOT repeat content from `coding-agent/AGENTS.md` or `coding-agent/src/core/AGENTS.md`
    - Do NOT include the "NEVER hardcode keybindings" rule (already in parent)
    - Do NOT use Write tool if file already exists — check first with `ls`
  **Parallelization**:
    - Can Run In Parallel: YES
    - Parallel Group: Wave 1
    - Blocks: TODO 13
    - Blocked By: None
  **References**:
    - `packages/coding-agent/src/modes/interactive/` (interactive-mode.ts, components/, theme/)
    - `packages/coding-agent/src/modes/interactive/components/` (35 .ts files)
    - `packages/coding-agent/src/modes/interactive/components/index.ts` (re-exports)
    - `packages/coding-agent/AGENTS.md` (parent — do NOT duplicate)
    - `packages/coding-agent/src/core/AGENTS.md` (do NOT duplicate)
  **Acceptance Criteria**:
    - File exists at `packages/coding-agent/src/modes/interactive/AGENTS.md`
    - File is 30-60 lines
    - Contains WHERE TO LOOK with at least 4 task→file mappings
    - Contains STRUCTURE section
    - Zero overlap with parent AGENTS.md files
  **QA Scenarios**:
    Scenario: Referenced files exist
      Tool: Bash
      Steps: Extract every file path from the new AGENTS.md. Verify each with `ls`.
      Expected Result: All referenced files/dirs exist
    Scenario: Component groupings are accurate
      Tool: Bash
      Steps: Run `ls packages/coding-agent/src/modes/interactive/components/`. Verify each component mentioned in the AGENTS.md exists, and verify no major component group is omitted.
      Expected Result: All mentioned components exist. No group of 3+ related components is missing from WHERE TO LOOK.

- [ ] 5. Verify packages/agent/AGENTS.md
  **What to do**:
    1. Read `packages/agent/AGENTS.md` in full
    2. Run `ls packages/agent/src/` and compare to Structure section
    3. Run `ls packages/agent/test/` and verify test info
    4. If ANY file listed in AGENTS.md doesn't exist, or any significant file is missing: Edit to fix
    5. If all accurate: no changes needed
  **Must NOT do**:
    - Do not rewrite for style
    - Do not add content that belongs in root AGENTS.md
  **Parallelization**:
    - Can Run In Parallel: YES
    - Parallel Group: Wave 1
    - Blocks: TODO 13
    - Blocked By: None
  **References**:
    - `packages/agent/AGENTS.md`
    - `packages/agent/src/` (5 files: agent-loop.ts, agent.ts, index.ts, proxy.ts, types.ts)
  **Acceptance Criteria**:
    - Every file path in AGENTS.md exists on disk
    - No files >300 lines in src/ are missing from the doc
  **QA Scenarios**:
    Scenario: Structure matches disk
      Tool: Bash
      Steps: `ls packages/agent/src/` and compare to AGENTS.md structure listing
      Expected Result: 1:1 match or documented reason for omission

- [ ] 6. Verify packages/ai/src/providers/AGENTS.md
  **What to do**:
    1. Read `packages/ai/src/providers/AGENTS.md` in full
    2. Run `ls packages/ai/src/providers/` and compare to provider table
    3. If any provider file is missing from the table, or any listed provider doesn't exist: Edit to fix
    4. If all accurate: no changes needed
  **Must NOT do**:
    - Do not rewrite for style
    - Do not repeat content from parent `ai/AGENTS.md`
  **Parallelization**:
    - Can Run In Parallel: YES
    - Parallel Group: Wave 1
    - Blocks: TODO 13
    - Blocked By: None
  **References**:
    - `packages/ai/src/providers/AGENTS.md`
    - `packages/ai/src/providers/` (16 files: anthropic.ts, openai-responses.ts, openai-codex-responses.ts, openai-completions.ts, azure-openai-responses.ts, google.ts, google-vertex.ts, google-gemini-cli.ts, amazon-bedrock.ts, mistral.ts, transform-messages.ts, openai-responses-shared.ts, google-shared.ts, simple-options.ts, register-builtins.ts, github-copilot-headers.ts)
  **Acceptance Criteria**:
    - Every .ts file in providers/ is either listed in the Providers table or the Shared Modules section
    - No listed file is missing from disk
  **QA Scenarios**:
    Scenario: Provider table completeness
      Tool: Bash
      Steps: `ls packages/ai/src/providers/*.ts`. Cross-reference each file against AGENTS.md.
      Expected Result: Every file appears in either Providers table or Shared Modules. Zero unaccounted files.

- [ ] 7. Verify packages/coding-agent/src/core/AGENTS.md
  **What to do**:
    1. Read `packages/coding-agent/src/core/AGENTS.md` in full
    2. Run `ls packages/coding-agent/src/core/` and compare to Key Modules table
    3. Check if significant files are missing from the table: `diagnostics.ts`, `exec.ts`, `messages.ts`, `resolve-config-value.ts`, `footer-data-provider.ts`, `auth-storage.ts`, `defaults.ts`, `slash-commands.ts`, `timings.ts`
    4. Only add files to the table if they're significant entry points an agent would need to know about. Minor utility files can stay unlisted.
    5. Verify Subdirectories section and Conventions section accuracy
  **Must NOT do**:
    - Do not list every file — only significant modules
    - Do not repeat content from parent coding-agent/AGENTS.md
  **Parallelization**:
    - Can Run In Parallel: YES
    - Parallel Group: Wave 1
    - Blocks: TODO 13
    - Blocked By: None
  **References**:
    - `packages/coding-agent/src/core/AGENTS.md`
    - `packages/coding-agent/src/core/` (27 files + 4 subdirs)
  **Acceptance Criteria**:
    - Every file in the Key Modules table exists on disk
    - Subdirectories listed match actual subdirectories
    - Conventions section has no factually false claims
  **QA Scenarios**:
    Scenario: Key Modules table accuracy
      Tool: Bash
      Steps: For each file in the Key Modules table, run `ls packages/coding-agent/src/core/<file>`
      Expected Result: All listed files exist

- [ ] 8. Verify packages/mom/AGENTS.md
  **What to do**:
    1. Read `packages/mom/AGENTS.md` in full
    2. Run `ls packages/mom/src/` and compare to Structure section
    3. If accurate: no changes. If stale: fix.
  **Must NOT do**:
    - Do not rewrite for style
  **Parallelization**:
    - Can Run In Parallel: YES
    - Parallel Group: Wave 1
    - Blocks: TODO 13
    - Blocked By: None
  **References**:
    - `packages/mom/AGENTS.md`
    - `packages/mom/src/` (9 files + tools/)
  **Acceptance Criteria**:
    - Every path in AGENTS.md exists on disk
  **QA Scenarios**:
    Scenario: Structure matches disk
      Tool: Bash
      Steps: `ls packages/mom/src/` and compare
      Expected Result: Match

- [ ] 9. Verify packages/pods/AGENTS.md
  **What to do**:
    1. Read `packages/pods/AGENTS.md` in full
    2. Run `ls packages/pods/src/` and compare to Structure section
    3. If accurate: no changes. If stale: fix.
  **Must NOT do**:
    - Do not rewrite for style
  **Parallelization**:
    - Can Run In Parallel: YES
    - Parallel Group: Wave 1
    - Blocks: TODO 13
    - Blocked By: None
  **References**:
    - `packages/pods/AGENTS.md`
    - `packages/pods/src/` (cli.ts, commands/, config.ts, index.ts, model-configs.ts, models.json, ssh.ts, types.ts)
  **Acceptance Criteria**:
    - Every path in AGENTS.md exists on disk
  **QA Scenarios**:
    Scenario: Structure matches disk
      Tool: Bash
      Steps: `ls packages/pods/src/` and compare
      Expected Result: Match

- [ ] 10. Verify packages/tui/AGENTS.md
  **What to do**:
    1. Read `packages/tui/AGENTS.md` in full
    2. Run `ls packages/tui/src/` and compare to Structure section
    3. If accurate: no changes. If stale: fix.
  **Must NOT do**:
    - Do not rewrite for style
  **Parallelization**:
    - Can Run In Parallel: YES
    - Parallel Group: Wave 1
    - Blocks: TODO 13
    - Blocked By: None
  **References**:
    - `packages/tui/AGENTS.md`
    - `packages/tui/src/` (14 files + components/)
  **Acceptance Criteria**:
    - Every path in AGENTS.md exists on disk
  **QA Scenarios**:
    Scenario: Structure matches disk
      Tool: Bash
      Steps: `ls packages/tui/src/` and compare
      Expected Result: Match

- [ ] 11. Verify packages/web-ui/AGENTS.md
  **What to do**:
    1. Read `packages/web-ui/AGENTS.md` in full
    2. Run `ls packages/web-ui/src/` and compare to Structure section
    3. Verify "Lit + mini-lit, NOT React" claim is still accurate
    4. Verify sandbox runtime provider warning is still accurate
    5. If accurate: no changes. If stale: fix.
  **Must NOT do**:
    - Do not rewrite for style
  **Parallelization**:
    - Can Run In Parallel: YES
    - Parallel Group: Wave 1
    - Blocks: TODO 13
    - Blocked By: None
  **References**:
    - `packages/web-ui/AGENTS.md`
    - `packages/web-ui/src/` (components/, dialogs/, prompts/, storage/, tools/, utils/, ChatPanel.ts, index.ts)
  **Acceptance Criteria**:
    - Every path in AGENTS.md exists on disk
    - "NOT React" claim is factually accurate
  **QA Scenarios**:
    Scenario: Structure matches disk
      Tool: Bash
      Steps: `ls packages/web-ui/src/` and compare
      Expected Result: Match
    Scenario: Lit claim verification
      Tool: Grep
      Steps: `grep -r "from 'lit'" packages/web-ui/src/ | head -3` — confirm Lit is used, not React
      Expected Result: Lit imports found, zero React imports

- [ ] 12. Verify root ./AGENTS.md
  **What to do**:
    1. Read `./AGENTS.md` in full
    2. Verify dependency graph: `ai ← agent ← coding-agent ← mom`, `tui (standalone)`, `pods ← agent`, `web-ui ← ai, tui`
    3. Verify package.json scripts match Commands section
    4. Verify "Adding a New LLM Provider" checklist references existing files
    5. Verify Structure section lists all 7 packages with correct descriptions
    6. If any fact is stale: fix with Edit tool. If accurate: no changes.
  **Must NOT do**:
    - Do NOT trim the file to fit 50-150 guideline — 280 lines of dev rules are all critical
    - Do NOT change operational rules (git safety, PR workflow, release process)
  **Parallelization**:
    - Can Run In Parallel: YES
    - Parallel Group: Wave 1
    - Blocks: TODO 13
    - Blocked By: None
  **References**:
    - `./AGENTS.md` (~280 lines)
    - `./package.json` (scripts section)
    - `packages/ai/src/types.ts`, `packages/ai/src/stream.ts`, `packages/ai/src/providers/` (provider checklist references)
  **Acceptance Criteria**:
    - Dependency graph matches actual package.json dependencies
    - Every file path in "Adding a New LLM Provider" section exists on disk
    - Package list in Structure section matches `ls packages/`
  **QA Scenarios**:
    Scenario: Provider checklist accuracy
      Tool: Bash
      Steps: For each file path in the "Adding a New LLM Provider" section, verify it exists with `ls`
      Expected Result: All referenced files exist
    Scenario: Package list accuracy
      Tool: Bash
      Steps: `ls packages/` and compare to Structure section listing
      Expected Result: All packages listed, no unlisted packages

- [ ] 13. Deduplication + hierarchy review
  **What to do**:
    1. Read ALL 12 AGENTS.md files in order (root → packages → subdirectories):
       - `./AGENTS.md`
       - `packages/agent/AGENTS.md`
       - `packages/ai/AGENTS.md`
       - `packages/ai/src/providers/AGENTS.md`
       - `packages/coding-agent/AGENTS.md`
       - `packages/coding-agent/src/core/AGENTS.md`
       - `packages/coding-agent/src/modes/interactive/AGENTS.md` (NEW)
       - `packages/coding-agent/examples/extensions/AGENTS.md` (NEW)
       - `packages/mom/AGENTS.md`
       - `packages/pods/AGENTS.md`
       - `packages/tui/AGENTS.md`
       - `packages/web-ui/AGENTS.md`
    2. For each child file, verify NO content is duplicated from its parent:
       - `ai/src/providers/AGENTS.md` vs parent `ai/AGENTS.md`
       - `coding-agent/src/core/AGENTS.md` vs parent `coding-agent/AGENTS.md`
       - `coding-agent/src/modes/interactive/AGENTS.md` vs parents `coding-agent/AGENTS.md` AND `coding-agent/src/core/AGENTS.md`
       - `coding-agent/examples/extensions/AGENTS.md` vs parent `coding-agent/AGENTS.md`
    3. Check for generic advice in any file — remove if found
    4. Verify size limits: subdirs 30-80 lines
    5. If any violation found: fix with Edit tool
  **Must NOT do**:
    - Do not merge or consolidate files
    - Do not delete any AGENTS.md
    - Do not change accurate content for style reasons
  **Parallelization**:
    - Can Run In Parallel: NO
    - Parallel Group: Wave 2
    - Blocks: None
    - Blocked By: TODO 1-12
  **References**:
    - All 12 AGENTS.md file paths listed above
  **Acceptance Criteria**:
    - Zero duplicated sentences/paragraphs between parent and child files
    - All subdirectory AGENTS.md files are 30-80 lines
    - Zero generic advice (e.g., "use meaningful names", "write tests", "follow best practices")
    - Final hierarchy matches expected tree (see below)
  **QA Scenarios**:
    Scenario: No parent-child duplication
      Tool: Read
      Steps: Read `coding-agent/AGENTS.md` and `coding-agent/src/core/AGENTS.md`. Search for any sentence that appears in both.
      Expected Result: Zero duplicated sentences
    Scenario: Size limits
      Tool: Bash
      Steps: For each subdir AGENTS.md, count lines with `wc -l`
      Expected Result: All between 30-80 lines (root exempted)

---

## Final Verification Wave

- [ ] F1. Plan Compliance Audit
  Verify all 13 TODOs completed. Check each acceptance criterion.

- [ ] F2. File Reference Integrity
  For every AGENTS.md, extract all file paths and verify each exists on disk using `ls`.

- [ ] F3. Hierarchy Validation
  Confirm final tree matches:
  ```
  ./AGENTS.md (root)
  ├── packages/agent/AGENTS.md
  ├── packages/ai/AGENTS.md
  │   └── packages/ai/src/providers/AGENTS.md
  ├── packages/coding-agent/AGENTS.md
  │   ├── packages/coding-agent/src/core/AGENTS.md
  │   ├── packages/coding-agent/src/modes/interactive/AGENTS.md  ← NEW
  │   └── packages/coding-agent/examples/extensions/AGENTS.md    ← NEW
  ├── packages/mom/AGENTS.md
  ├── packages/pods/AGENTS.md
  ├── packages/tui/AGENTS.md
  └── packages/web-ui/AGENTS.md
  ```

- [ ] F4. Scope Fidelity Check
  Verify NO AGENTS.md was created in scored-out directories:
  - `packages/coding-agent/src/core/tools/AGENTS.md` must NOT exist
  - `packages/coding-agent/src/core/extensions/AGENTS.md` must NOT exist
  - `packages/coding-agent/src/core/compaction/AGENTS.md` must NOT exist
  - `packages/web-ui/src/tools/artifacts/AGENTS.md` must NOT exist
  - `packages/web-ui/src/components/AGENTS.md` must NOT exist
  - `packages/tui/src/components/AGENTS.md` must NOT exist
  - `packages/ai/src/utils/AGENTS.md` must NOT exist

---

## Success Criteria

1. All 12 AGENTS.md files are accurate — every referenced file path exists on disk
2. 2 confirmed bugs fixed (coding-agent stale `pipe/` reference, ai stale `context.ts` + missing files)
3. 2 new files created (examples/extensions, modes/interactive)
4. Zero parent-child content duplication
5. Zero generic advice in any file
6. All subdirectory files within 30-80 line limit
7. Hierarchy tree matches expected structure (12 files total)

---

## Scoring Audit (for reference)

Directories that were evaluated and **rejected** (score <8):

| Directory | Score | Reason Skipped |
|-----------|-------|----------------|
| `coding-agent/src/core/tools/` | 7 | Parent `core/AGENTS.md` covers tools section |
| `coding-agent/src/core/extensions/` | 7 | Parent `core/AGENTS.md` covers extensions section |
| `coding-agent/src/core/compaction/` | 5 | 4 files, parent covers |
| `web-ui/src/tools/artifacts/` | 10 | Borderline — parent `web-ui/AGENTS.md` covers artifacts section |
| `web-ui/src/components/` | 8 | Parent covers component listing |
| `web-ui/src/components/sandbox/` | 5 | 7 files, parent covers |
| `tui/src/components/` | 6 | Parent covers |
| `ai/src/utils/` | 5 | Parent covers |
| `ai/src/utils/oauth/` | 5 | Parent covers |
| `coding-agent/src/utils/` | 6 | 14 files but no module boundary, parent covers |
| `coding-agent/src/cli/` | 5 | 5 files, parent covers |
| `coding-agent/src/modes/rpc/` | 5 | 4 files, parent covers |
| `mom/src/tools/` | 4 | 7 files, parent covers |
| `pods/src/commands/` | 3 | 3 files, parent covers |
| `scripts/` | 4 | 8 files, root covers |
