# Verifier Agent Guidance

## Purpose
This document provides explicit instructions for spawned verifier agents performing code review verifications in the spec-mode-v1 mission.

## Mission Context
This is an **extension-first architecture** mission:
- Core changes minimal: ExtensionApi additions in packages/coding-agent/src/extensions/
- Implementation lives in `~/.mu/agent/extensions/spec-mode/`
- Pattern: extension using existing primitives (registerCommand, context hook, state storage)

## Real Code Paths
Before reviewing, understand these actual integration points:
- Extension loader: `packages/coding-agent/src/extensions/loader.ts` discovers from `~/.mu/agent/extensions/`
- Command registration: `registerCommand()` in ExtensionApi, surfaced via `TuiRenderer`
- State storage: ExtensionManager persists to `~/.mu/agent/extensions/<name>/state.json`
- Footer indicators: FooterComponent reads from ExtensionManager registry

## Review Process (Step by Step)

### 1. Gather Evidence
```bash
# See what files changed in core
git diff --name-only HEAD~1 | grep packages/

# See what files exist in extension
ls -la ~/.mu/agent/extensions/spec-mode/

# See the actual changes
git diff HEAD~1
```

### 2. Read Implementation Files

**Milestone 1 (core-api-and-extension):**

Core API files:
- `packages/coding-agent/src/extensions/types.ts` — ExtensionApi signatures
- `packages/coding-agent/src/extensions/manager.ts` — Implementation

Key APIs to verify:
- `getExtensionState(key: string): T | undefined`
- `setExtensionState(key: string, state: T): void`
- `registerExtensionIndicator(options): void`
- `updateExtensionIndicator(id, options): void`
- `removeExtensionIndicator(id): void`

Extension files:
- `~/.mu/agent/extensions/spec-mode/index.ts` — Extension factory
- `~/.mu/agent/extensions/spec-mode/reminders.ts` — Reminder templates
- `~/.mu/agent/extensions/spec-mode/verifier.ts` — Verifier integration

Key behaviors to verify:
- Extension uses `registerCommand` (NOT a new "persistent command" primitive)
- Commands use `getExtensionState`/`setExtensionState` for persistence
- Context hook appends reminders to system prompt
- Commands print confirmation via `api.print()`
- Optional: `registerExtensionIndicator` for footer badge

**Milestone 2 (verifier-integration):**
- `~/.mu/agent/extensions/spec-mode/verifier.ts` — Verifier spawn logic

Key behaviors to verify:
- Spawns verifier child agent via `spawn_agent`
- Passes validation contract to child context
- Receives PASS/FAIL response with findings array
- Handles spawn failure gracefully (no session wedge)

### 3. Compare Against SPEC.md
Check each requirement from `devdocs/missions/spec-mode-v1/SPEC.md`:

**What Must be True:**
- [ ] Extension lives in `~/.mu/agent/extensions/spec-mode/`
- [ ] Extension registers three slash commands: /spec, /discover, /normal
- [ ] Commands use extension state storage (getExtensionState/setExtensionState)
- [ ] TuiRenderer integration: commands appear in slash overlay
- [ ] Visual feedback: confirmation messages show current mode
- [ ] Context hook appends reminder to system prompt when mode active
- [ ] Mode state persists across reloads
- [ ] Verifier agent can validate spec output
- [ ] Extension reload restores previous mode state

**What Must Never Happen:**
- [ ] Core implementation does not hardcode spec-mode logic
- [ ] Mode state does not interfere with other extensions
- [ ] Extension does not break existing slash commands
- [ ] Mode change during streaming does not crash

### 4. Check for Issues
Look for problems that impact:
- **Correctness**: Does it match the spec?
- **Completeness**: Are all requirements addressed?
- **Integration**: Do the real code paths work (loader, TuiRenderer, FooterComponent)?
- **Edge cases**: Reload, multiple extensions, streaming, verifier failure?
- **Non-breaking**: Existing extensions still work?

### 5. Write Findings
Create JSON file at the specified evidence path:

```json
{
  "findings": [
    {
      "category": "architecture|completeness|integration|edge-cases",
      "severity": "blocking|major|minor",
      "title": "Brief description of issue",
      "body": "Detailed explanation with context",
      "recommendation": "What should be changed"
    }
  ],
  "overall_assessment": "pass|needs-improvement|fail",
  "overall_summary": "Brief summary of mission quality"
}
```

**Severity definitions:**
- `blocking`: Must fix before milestone can be accepted
- `major`: Should fix, but doesn't block if workaround exists
- `minor`: Nice to have, doesn't block

**If no issues found:**
```json
{
  "findings": [],
  "overall_assessment": "pass",
  "overall_summary": "Implementation matches SPEC.md requirements. Core API additions are minimal and non-breaking. Extension correctly uses existing primitives and implements all required functionality."
}
```

## Example Review Commands

### M1 Core API Review
```bash
# Check ExtensionApi types
git diff packages/coding-agent/src/extensions/types.ts | head -100

# Check ExtensionManager implementation
git diff packages/coding-agent/src/extensions/manager.ts | head -100

# Check state storage
cat packages/coding-agent/src/extensions/manager.ts | grep -A10 'getExtensionState\|setExtensionState'

# Check indicator API
cat packages/coding-agent/src/extensions/manager.ts | grep -A10 'registerExtensionIndicator'

# Check FooterComponent integration
cat packages/coding-agent/src/tui/footer.ts | grep -B5 -A10 'ExtensionManager\|indicator'
```

### M1 Extension Review
```bash
# Check extension exists at correct path
ls -la ~/.mu/agent/extensions/spec-mode/

# Check extension structure
cat ~/.mu/agent/extensions/spec-mode/index.ts | head -60

# Verify registerCommand usage (not new primitive)
cat ~/.mu/agent/extensions/spec-mode/index.ts | grep -n 'registerCommand'

# Verify state storage usage
cat ~/.mu/agent/extensions/spec-mode/index.ts | grep -n 'getExtensionState\|setExtensionState'

# Check context hook
cat ~/.mu/agent/extensions/spec-mode/index.ts | grep -n 'context'

# Check reminder templates
cat ~/.mu/agent/extensions/spec-mode/reminders.ts | head -50

# Check spec reminder structure
cat ~/.mu/agent/extensions/spec-mode/reminders.ts | grep -A5 'Spec mode\|Summary'
```

### M2 Verifier Review
```bash
# Check verifier implementation
cat ~/.mu/agent/extensions/spec-mode/verifier.ts | head -50

# Check spawn_agent usage
cat ~/.mu/agent/extensions/spec-mode/verifier.ts | grep -n 'spawn_agent\|spawnAgent'

# Check validation contract
cat ~/.mu/agent/extensions/spec-mode/verifier.ts | grep -n 'validation\|Validation'

# Check failure handling
cat ~/.mu/agent/extensions/spec-mode/verifier.ts | grep -n 'catch\|error\|fail'
```

## Decision Rule

**PASS (overall_assessment: pass):**
- All SPEC.md requirements implemented
- Core API additions are minimal and non-breaking
- Extension lives in `~/.mu/agent/extensions/spec-mode/`
- Real integration points work (TuiRenderer, FooterComponent)
- Edge cases handled (reload, multiple extensions, streaming, verifier failure)
- No blocking findings

**FAIL (overall_assessment: fail):**
- Extension not in `~/.mu/agent/extensions/`
- Uses wrong path (`~/.mu/extensions/`)
- Claims "no TuiRenderer changes" but actually needs them
- Any blocking finding exists
- Evidence not properly captured

**What to do on FAIL:**
1. Write detailed findings with file/line references
2. Set severity to "blocking" for any SPEC.md requirement gap
3. Do not mark gate task as done
4. Add fix tasks to TASKS.json if needed

## Key Principles for This Mission

1. **Extension path**: Must be `~/.mu/agent/extensions/spec-mode/`, NOT `~/.mu/extensions/`
2. **Existing primitives**: Use `registerCommand`, NOT a new "persistent command" abstraction
3. **Real integration**: Acknowledge TuiRenderer and FooterComponent integration points
4. **State storage**: Use `getExtensionState`/`setExtensionState`, NOT AgentState
5. **Edge cases**: Reload, multiple extensions, streaming, verifier failure must be handled

## Reference
- SPEC.md: `devdocs/missions/spec-mode-v1/SPEC.md`
- Architecture: `devdocs/missions/spec-mode-v1/ARCHITECTURE.md`
- Extension loader: `packages/coding-agent/src/extensions/loader.ts`
- Extension types: `packages/coding-agent/src/extensions/types.ts`
- Canonical review guidance: `~/.mu/agent/docs/missions-starter-kit.md`
