---
mode: build
---

# Summary & Recommendation
Implement spec mode as an extension in `~/.mu/agent/extensions/spec-mode/` using existing extension primitives (registerCommand, context hook, beforeToolCall). The extension registers three slash commands (/spec, /discover, /normal) that maintain state via extension storage, show visual feedback in the TUI, and append structured reminders to the system prompt.

# What Must be True
- Extension lives in `~/.mu/agent/extensions/spec-mode/`
- Extension registers three slash commands: /spec, /discover, /normal
- Commands use extension state storage (getExtensionState/setExtensionState) to persist mode
- TuiRenderer integration: commands appear in slash overlay and print confirmation on execution
- Visual feedback: confirmation message shows current mode; footer indicator integration via extension API additions
- Context hook appends structured reminder to system prompt when mode is spec/discover
- Mode state persists across interactions until explicitly changed
- Verifier agent can validate spec output against validation contracts
- Extension reload restores previous mode state

# What Must Never Happen
- Core implementation must not hardcode spec-mode logic
- Mode state must not interfere with other extensions
- Extension must not break existing slash command infrastructure
- Mode change during streaming must not crash or lose state

# Inputs / Outputs
- Input: User types /spec, /discover, or /normal
- Input: Extension state storage via ExtensionApi (getExtensionState/setExtensionState)
- Output: Confirmation message printed to chat (visible in TUI)
- Output: System prompt suffix via context hook
- Output: Optional footer indicator via extension-indicator API
- Output: Verifier spawn for validation

# Edge Cases
- Multiple extensions with indicators: badges stack or priority system works
- Extension reload while mode is active: state restored from extension storage
- Mode change during streaming: queued or blocked gracefully
- Verifier agent spawn failure: degrades visibly without wedging session

# Constraints
- Extension uses existing registerCommand API (no new persistent command primitive)
- Core changes minimal: extension state storage API, optional indicator API
- Implementation lives entirely in `~/.mu/agent/extensions/spec-mode/`
- No changes to packages/ except extension API additions for state storage and indicators
- Extension uses existing hooks: context, beforeToolCall (optional), afterToolResult (optional)

# Definition of Done
- Extension loads from `~/.mu/agent/extensions/spec-mode/`
- /spec, /discover, /normal commands work and persist state
- Context hook appends reminders to system prompt
- Visual feedback shows current mode (confirmation messages)
- Extension reload restores previous mode
- Multiple extensions can coexist
- Verifier agent integration works
- Build passes (npm run check)

# Verification Contract
- npm test -w @kennyfrc/mu-coding-agent -- spec-mode
- xtui verification: slash commands appear, confirmation messages show
- Log verification: system prompt includes suffix when mode active
- Extension reload test: mode state persists
- Edge case tests: multiple extensions, streaming mode change, verifier failure

# What needs to be done to deliver the spec
1. Implement extension state storage API (getExtensionState/setExtensionState)
2. Implement optional footer indicator API (registerExtensionIndicator)
3. Create spec-mode extension in `~/.mu/agent/extensions/spec-mode/`
4. Create behavioral tests for spec-mode extension
5. Create edge case tests (reload, multiple extensions, streaming, verifier failure)
6. Run xtui verification
7. Run log verification
8. Final acceptance gate
