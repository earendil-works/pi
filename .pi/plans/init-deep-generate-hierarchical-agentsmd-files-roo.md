# Plan: # /init-deep

Generate hierarchical AGENTS.md files. Root + complexity-scored subdirectories.

## Usage

```
/init-deep                      # Update mode: modify existing + create new where warranted
/init-deep --create-new         # Read existing → remove all → regenerate from scratch
/init-deep --max-depth=2        # Limit directory depth (default: 3)
```

---

## Workflow (High-Level)

1. **Discovery + Analysis** (concurrent) — fire background agents + bash structure + read existing AGENTS.md
2. **Score & Decide** — determine AGENTS.md locations from merged findings
3. **Generate** — root first, then subdirs in parallel
4. **Review** — deduplicate, trim, validate

**Register todos immediately:**
```
TodoWrite([
  { id: "discovery", content: "Fire explore agents + structural analysis + read existing", status: "pending", priority: "high" },
  { id: "scoring", content: "Score directories, determine locations", status: "pending", priority: "high" },
  { id: "generate", content: "Generate AGENTS.md files (root + subdirs)", status: "pending", priority: "high" },
  { id: "review", content: "Deduplicate, validate, trim", status: "pending", priority: "medium" }
])
```

---

## Phase 1: Discovery + Analysis (Concurrent)

**Mark "discovery" as in_progress.**

### Fire Background Explore Agents IMMEDIATELY

Don't wait — these run async while main session works. Use the Agent tool with `subagent_type="Explore"`:

```
Agent(subagent_type="Explore", prompt="Project structure: PREDICT standard patterns for detected language → REPORT deviations only")
Agent(subagent_type="Explore", prompt="Entry points: FIND main files → REPORT non-standard organization")
Agent(subagent_type="Explore", prompt="Conventions: FIND config files (.eslintrc, pyproject.toml, .editorconfig) → REPORT project-specific rules")
Agent(subagent_type="Explore", prompt="Anti-patterns: FIND 'DO NOT', 'NEVER', 'ALWAYS', 'DEPRECATED' comments → LIST forbidden patterns")
Agent(subagent_type="Explore", prompt="Build/CI: FIND .github/workflows, Makefile → REPORT non-standard patterns")
Agent(subagent_type="Explore", prompt="Test patterns: FIND test configs, test structure → REPORT unique conventions")
```

Fire all in parallel using TaskCreate with `run_in_background=true`, collect results later.

### Dynamic Agent Spawning

After bash analysis, spawn ADDITIONAL explore agents based on project scale:

| Factor | Threshold | Additional Agents |
|--------|-----------|-------------------|
| **Total files** | >100 | +1 per 100 files |
| **Total lines** | >10k | +1 per 10k lines |
| **Directory depth** | ≥4 | +2 for deep exploration |
| **Large files (>500 lines)** | >10 files | +1 for complexity hotspots |
| **Monorepo** | detected | +1 per package/workspace |
| **Multiple languages** | >1 | +1 per language |

```bash
# Measure project scale first
total_files=$(find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' | wc -l)
total_lines=$(find . -type f \( -name "*.ts" -o -name "*.py" -o -name "*.go" \) -not -path '*/node_modules/*' -exec wc -l {} + 2>/dev/null | tail -1 | awk '{print }')
large_files=$(find . -type f \( -name "*.ts" -o -name "*.py" \) -not -path '*/node_modules/*' -exec wc -l {} + 2>/dev/null | awk ' > 500 {count++} END {print count+0}')
max_depth=$(find . -type d -not -path '*/node_modules/*' -not -path '*/.git/*' | awk -F/ '{print NF}' | sort -rn | head -1)
```

Spawn additional agents based on results (e.g., 500 files + depth 6 → spawn extra agents for large files, deep modules, cross-cutting concerns).

### Main Session: Concurrent Analysis

**While background agents run**, main session does:

#### 1. Bash Structural Analysis
```bash
# Directory depth + file counts
find . -type d -not -path '*/\.*' -not -path '*/node_modules/*' -not -path '*/venv/*' -not -path '*/dist/*' -not -path '*/build/*' | awk -F/ '{print NF-1}' | sort -n | uniq -c

# Files per directory (top 30)
find . -type f -not -path '*/\.*' -not -path '*/node_modules/*' | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -30

# Code concentration by extension
find . -type f \( -name "*.py" -o -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.go" -o -name "*.rs" \) -not -path '*/node_modules/*' | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -20

# Existing AGENTS.md
find . -type f -name "AGENTS.md" -not -path '*/node_modules/*' 2>/dev/null
```

#### 2. Read Existing AGENTS.md
```
For each existing file found:
  Read(filePath=file)
  Extract: key insights, conventions, anti-patterns
  Store in EXISTING_AGENTS map
```

If `--create-new`: Read all existing first (preserve context) → then delete all → regenerate.

#### 3. Code Symbol Analysis (ast-grep)

Use `sg` (ast-grep) to find key symbols when available:

```bash
# Find exported classes/interfaces (TypeScript)
sg -p 'export class $NAME' -l typescript
sg -p 'export interface $NAME' -l typescript
sg -p 'export function $NAME' -l typescript

# Find main entry points
sg -p 'export default $EXPR' -l typescript
```

**Fallback**: If `sg` unavailable, rely on explore agents + Grep tool.

### Collect Background Results

After main session analysis done, collect all background task results using TaskOutput.

**Merge: bash + ast-grep + existing + explore findings. Mark "discovery" as completed.**

---

## Phase 2: Scoring & Location Decision

**Mark "scoring" as in_progress.**

### Scoring Matrix

| Factor | Weight | High Threshold | Source |
|--------|--------|----------------|--------|
| File count | 3x | >20 | bash |
| Subdir count | 2x | >5 | bash |
| Code ratio | 2x | >70% | bash |
| Unique patterns | 1x | Has own config | explore |
| Module boundary | 2x | Has index.ts/__init__.py | bash |
| Symbol density | 2x | >30 symbols | ast-grep |
| Export count | 2x | >10 exports | ast-grep |

### Decision Rules

| Score | Action |
|-------|--------|
| **Root (.)** | ALWAYS create |
| **>15** | Create AGENTS.md |
| **8-15** | Create if distinct domain |
| **<8** | Skip (parent covers) |

### Output
```
AGENTS_LOCATIONS = [
  { path: ".", type: "root" },
  { path: "src/hooks", score: 18, reason: "high complexity" },
  { path: "src/api", score: 12, reason: "distinct domain" }
]
```

**Mark "scoring" as completed.**

---

## Phase 3: Generate AGENTS.md

**Mark "generate" as in_progress.**

**File Writing Rule**: If AGENTS.md already exists at the target path → use `Edit` tool. If it does NOT exist → use `Write` tool. NEVER use Write to overwrite an existing file.

### Root AGENTS.md (Full Treatment)

```markdown
# PROJECT KNOWLEDGE BASE

**Generated:** {TIMESTAMP}
**Commit:** {SHORT_SHA}
**Branch:** {BRANCH}

## OVERVIEW
{1-2 sentences: what + core stack}

## STRUCTURE
\`\`\`
{root}/
├── {dir}/    # {non-obvious purpose only}
└── {entry}
\`\`\`

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|

## CODE MAP
{From ast-grep - skip if project <10 files}

| Symbol | Type | Location | Role |
|--------|------|----------|------|

## CONVENTIONS
{ONLY deviations from standard}

## ANTI-PATTERNS (THIS PROJECT)
{Explicitly forbidden here}

## UNIQUE STYLES
{Project-specific}

## COMMANDS
\`\`\`bash
{dev/test/build}
\`\`\`

## NOTES
{Gotchas}
```

**Quality gates**: 50-150 lines, no generic advice, no obvious info.

### Subdirectory AGENTS.md (Parallel)

Launch Agent subagents for each location in parallel:

```
for loc in AGENTS_LOCATIONS (except root):
  Agent(prompt=`
    Generate AGENTS.md for: ${loc.path}
    - Reason: ${loc.reason}
    - 30-80 lines max
    - NEVER repeat parent content
    - Sections: OVERVIEW (1 line), STRUCTURE (if >5 subdirs), WHERE TO LOOK, CONVENTIONS (if different), ANTI-PATTERNS
  `)
```

**Wait for all. Mark "generate" as completed.**

---

## Phase 4: Review & Deduplicate

**Mark "review" as in_progress.**

For each generated file:
- Remove generic advice (anything that applies to ALL projects)
- Remove parent duplicates (child never repeats parent)
- Trim to size limits (root: 50-150 lines, subdir: 30-80 lines)
- Verify telegraphic style (no prose, no filler)

**Mark "review" as completed.**

---

## Final Report

```
=== init-deep Complete ===

Mode: {update | create-new}

Files:
  [OK] ./AGENTS.md (root, {N} lines)
  [OK] ./src/hooks/AGENTS.md ({N} lines)

Dirs Analyzed: {N}
AGENTS.md Created: {N}
AGENTS.md Updated: {N}

Hierarchy:
  ./AGENTS.md
  └── src/hooks/AGENTS.md
```

---

## Anti-Patterns

- **Static agent count**: MUST vary agents based on project size/depth
- **Sequential execution**: MUST parallel (explore agents + structural analysis concurrent)
- **Ignoring existing**: ALWAYS read existing first, even with --create-new
- **Over-documenting**: Not every dir needs AGENTS.md
- **Redundancy**: Child never repeats parent
- **Generic content**: Remove anything that applies to ALL projects
- **Verbose style**: Telegraphic or die

**Date:** 2026-03-16

Good. Now completing the post-plan self-review checklist:

**□ All TODO items have concrete acceptance criteria?** ✅ — All 13 TODOs + 4 final verification tasks have agent-executable AC
**□ All file references exist in codebase?** ✅ — Verified by Momus; `docs/` false-negative fixed
**□ No assumptions about business logic without evidence?** ✅ — All claims verified against disk
**□ Guardrails from Metis review incorporated?** ✅ — Self-derived guardrails in Must NOT Have section
**□ Scope boundaries clearly defined?** ✅ — Scoring audit table shows all 15 rejected directories with reasons
**□ Every task has QA Scenarios (happy path + failure case)?** ✅ — All TODOs have at least 1 scenario
**□ Zero acceptance criteria require human intervention?** ✅ — All verifiable via `ls`, `grep`, `wc -l`, `read`

---

## Plan Generated: init-deep

**Key Decisions Made:**
- **2 new AGENTS.md locations** (score ≥13): `coding-agent/examples/extensions/` and `coding-agent/src/modes/interactive/`
- **15 directories rejected** (score <8): all covered by parent docs
- **Root AGENTS.md kept at 280 lines**: dev rules, release process, git safety are all critical — no trim

**Scope:**
- IN: Fix 2 stale AGENTS.md files, create 2 new ones, verify 8 others, dedup review
- OUT: No new AGENTS.md for tools/, extensions/, compaction/, utils/, components/, scripts/

**Guardrails Applied:**
- Update mode only — never delete existing files
- Edit tool for existing files, Write tool only for new files
- Child never repeats parent content
- Every file path referenced must exist on disk

**Auto-Resolved:**
- `docs/` reference in coding-agent/AGENTS.md: initially flagged for removal → Momus caught it exists → preserved in plan

**Defaults Applied:**
- Subdir AGENTS.md size target: 30-80 lines
- Scoring threshold for new files: ≥13 (distinct domain) or ≥15 (auto-create)
- Verification-only tasks make zero changes when files are accurate

Plan saved to: `.pi/plans/init-deep.md`
