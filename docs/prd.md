# PRD: auto-cycle Droid Plugin

Replicate the full `/auto` automation lifecycle as a self-contained Droid plugin.

## Overview

Bundle the 5 existing hook scripts + shared library + memory droid + new SessionStart/SessionEnd hooks into a single Droid plugin at `~/.factory/plugins/local/auto-cycle/`. Originals stay in place untouched.

## Plugin Structure

```
auto-cycle/
├── .factory-plugin/
│   └── plugin.json
├── hooks/
│   ├── hooks.json
│   ├── neo4j_memory_common.py      # [COPY] shared library (912 lines)
│   ├── continue_until_complete.py   # [COPY] stop + prompt hook
│   ├── guard_clear.py              # [COPY] /clear protection
│   ├── gate_clear_complete.py      # [COPY] GATE_COMPLETE detector
│   ├── neo4j_prompt_context.py     # [COPY] prompt-time memory recall
│   ├── session_start_context.py    # [NEW] SessionStart context loader
│   └── session_end_save.py         # [NEW] SessionEnd memory saver
├── droids/
│   └── memory.md                   # [COPY] palace-structured memory agent
├── skills/
│   └── neo4j-memory/
│       └── SKILL.md                # [NEW] LLM-invocable memory skill
├── commands/
│   └── memory.md                   # [NEW] /memory slash command
└── README.md                       # [NEW] plugin documentation
```

## Tasks

### Wave 1: Scaffold (no dependencies)

#### T1: Create plugin manifest
- **File**: `.factory-plugin/plugin.json`
- **Action**: Create `{name: "auto-cycle", description: "...", version: "1.0.0"}`
- **Verify**: Valid JSON, required fields present

#### T2: Create hooks.json wiring
- **File**: `hooks/hooks.json`
- **Action**: Wire all 7 hook scripts to their events:
  - `SessionStart`: `session_start_context.py`
  - `SessionEnd`: `session_end_save.py`
  - `UserPromptSubmit`: `continue_until_complete.py`, `guard_clear.py`, `neo4j_prompt_context.py`
  - `Stop`: `continue_until_complete.py`, `gate_clear_complete.py`
- **All commands use**: `python3 ${DROID_PLUGIN_ROOT}/hooks/<script>.py`
- **Timeouts**: 10s for prompt hooks, 15s for session-end, 60s for stop hooks
- **Verify**: Valid JSON, all script paths use `${DROID_PLUGIN_ROOT}`

### Wave 2: Copy existing scripts (parallel, no dependencies)

#### T3: Copy neo4j_memory_common.py
- **Source**: `~/.factory/hooks/neo4j_memory_common.py`
- **Dest**: `hooks/neo4j_memory_common.py`
- **Action**: Byte-for-byte copy. No modifications needed (already uses `Path.home()` for state dirs).
- **Verify**: `diff` with source shows no changes

#### T4: Copy continue_until_complete.py
- **Source**: `~/.factory/hooks/continue_until_complete.py`
- **Dest**: `hooks/continue_until_complete.py`
- **Action**: Copy, then add `sys.path` adjustment at top for common import (if it imports common). Check: this script is self-contained (does NOT import neo4j_memory_common). Byte-for-byte copy.
- **Verify**: `python3 -c "import py_compile; py_compile.compile('hooks/continue_until_complete.py')"` passes

#### T5: Copy guard_clear.py
- **Source**: `~/.factory/hooks/guard_clear.py`
- **Dest**: `hooks/guard_clear.py`
- **Action**: Byte-for-byte copy. Self-contained (no common import).
- **Verify**: Compiles cleanly

#### T6: Copy gate_clear_complete.py
- **Source**: `~/.factory/hooks/gate_clear_complete.py`
- **Dest**: `hooks/gate_clear_complete.py`
- **Action**: Byte-for-byte copy. Self-contained.
- **Verify**: Compiles cleanly

#### T7: Copy neo4j_prompt_context.py
- **Source**: `~/.factory/hooks/neo4j_prompt_context.py`
- **Dest**: `hooks/neo4j_prompt_context.py`
- **Action**: Copy. This script DOES import from `neo4j_memory_common`. Add `sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))` before the import so it finds the co-located copy.
- **Verify**: `python3 -c "import sys; sys.path.insert(0, 'hooks'); import neo4j_prompt_context"` does not crash (may fail on stdin, that's ok)

#### T8: Copy memory.md droid
- **Source**: `~/.factory/droids/memory.md`
- **Dest**: `droids/memory.md`
- **Action**: Byte-for-byte copy.
- **Verify**: File exists, has YAML frontmatter with `name: memory`

### Wave 3: New hook scripts (depends on T3 for common library)

#### T9: Create session_start_context.py
- **File**: `hooks/session_start_context.py`
- **Action**: New SessionStart hook that:
  1. Reads hook input JSON from stdin
  2. Skips if `source` is `"clear"` or `"compact"`
  3. Resolves repo root from `$FACTORY_PROJECT_DIR` or `cwd`
  4. Loads Neo4j config via `load_neo4j_config()`
  5. Resolves project record via `resolve_project_record()`
  6. Fetches startup learnings/patterns/bugs via `fetch_startup_*()` functions
  7. Ranks with `rank_memory_records()` using `SESSION_START_SELECTION_LIMITS`
  8. Builds context string via `build_session_start_context()`
  9. Emits JSON: `{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: "..."}}`
  10. Touches loaded nodes for reuse tracking
- **Imports**: `neo4j_memory_common` (add sys.path)
- **Timeout**: 10s
- **Graceful failure**: Silent exit 0 if Neo4j unavailable or no project found
- **Verify**: `python3 -c "import py_compile; py_compile.compile('hooks/session_start_context.py')"` passes

#### T10: Create session_end_save.py
- **File**: `hooks/session_end_save.py`
- **Action**: New SessionEnd hook that:
  1. Reads hook input JSON from stdin
  2. Loads transcript entries from `transcript_path` via `load_transcript_entries()`
  3. Checks `meaningful_user_interaction_count()` >= `MIN_USER_INTERACTIONS_FOR_MEMORY_REVIEW` (6)
  4. Checks `session_needs_memory_review()` (edits or high-signal text)
  5. Checks `session_already_saved_memory()` to avoid duplicates
  6. If worth saving: extract summary from transcript (first user message as task, last assistant message as outcome, list of edited files from tool_use blocks)
  7. Connects to Neo4j, resolves project, creates Episode + Learning/Memory nodes
  8. Uses palace structure: Wing -> Room -> Drawer with hall classification
  9. Silent exit 0 on any failure
- **Imports**: `neo4j_memory_common` (add sys.path)
- **Timeout**: 15s
- **Verify**: Compiles cleanly

### Wave 4: Skills, commands, docs (parallel, depends on T8)

#### T11: Create SKILL.md
- **File**: `skills/neo4j-memory/SKILL.md`
- **Action**: Create skill with frontmatter `name: neo4j-memory`, `description: "..."`.
  Body describes: the memory droid is available for recall/remember/context operations,
  when to use it (save learnings, recall project context, query past decisions),
  how to invoke it (via Task tool with memory droid).
- **Verify**: Has valid frontmatter with `name` and `description`

#### T12: Create /memory command
- **File**: `commands/memory.md`
- **Action**: Create slash command with frontmatter `description: "Query or save project memory via Neo4j"`.
  Body prompts the LLM to use the memory droid for the user's `$ARGUMENTS`.
- **Verify**: Has valid frontmatter with `description`

#### T13: Create README.md
- **File**: `README.md`
- **Action**: Document the plugin: what it does, all hooks, droid, skill, command, env vars, installation.
- **Verify**: Exists and is non-empty

### Wave 5: Installation + integration test

#### T14: Register as local marketplace + install
- **Action**:
  ```bash
  droid plugin marketplace add ~/.factory/plugins/local/auto-cycle
  droid plugin install auto-cycle@auto-cycle --scope user
  ```
- **Verify**: `cat ~/.factory/plugins/installed_plugins.json` shows `auto-cycle@auto-cycle`
- **Verify**: `/plugins` UI shows it in Installed tab

#### T15: Disable duplicate hooks in settings.json
- **Action**: Once plugin is active, the original hooks in `settings.json` will run IN PARALLEL with plugin hooks. This means `continue_until_complete.py` fires TWICE (once from settings, once from plugin). Either:
  - Remove the originals from `settings.json` hooks (preferred), OR
  - Add dedup logic to the scripts (complex)
- **Decision needed from user**: Whether to remove originals from settings.json after plugin is confirmed working.
- **Note**: The original FILES in `~/.factory/hooks/` stay untouched regardless.

#### T16: Smoke test
- **Action**: Start a new droid session, verify:
  1. SessionStart hook fires and Neo4j context is loaded (check transcript mode Ctrl-R)
  2. UserPromptSubmit enriches with relevant memories
  3. `/continue-until-complete` activates the loop
  4. On session exit, session-end hook saves a memory (check Neo4j)
  5. `/memory recall <topic>` works via the memory droid
- **Verify**: All 5 checks pass

## Risk: Hook Deduplication (T15)

Plugin hooks run ALONGSIDE user settings hooks. Since `continue_until_complete.py` is already wired in `settings.json`, it will fire twice when the plugin is active. Same for any other hooks the user later wires from the originals.

**Mitigation options:**
1. After confirming the plugin works, remove duplicates from `settings.json` hooks section (keep notify.sh and other non-replicated hooks)
2. Scripts can detect they're already running via a session-scoped lock file
3. Accept idempotent double-execution (works for most hooks but may double-inject context)

**Recommended**: Option 1 after T16 smoke test passes.

## Dependencies Graph

```
T1, T2 ──────────────────────────┐
T3, T4, T5, T6, T7, T8 (parallel) ──┤
                                      ├── T9, T10 (need T3)
                                      ├── T11, T12, T13 (parallel)
                                      └── T14 (needs all above)
                                           └── T15, T16 (needs T14)
```
