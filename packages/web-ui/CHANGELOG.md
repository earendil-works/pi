# Changelog

## [Unreleased]

### Added

- `onModelSelect` callback on `AgentInterface` and `ChatPanel.setAgent` config
- `allowedProviders` filter on `ModelSelector.open()` to restrict visible models
- `onClose` callback on `SettingsDialog.open()`
- `state_change` event emitted by Agent on `setModel()` and `setThinkingLevel()`
- Subsequence-based fuzzy search in model selector (replaces substring matching)
- `openai-codex` and `github-copilot` to `shouldUseProxyForProvider`

### Changed

- Anthropic test model updated from `claude-3-5-haiku-20241022` to `claude-haiku-4-5`

### Fixed

- `AgentInterface` clears streaming container on `message_end` to prevent duplicate tool rendering

## [0.58.3] - 2026-03-15

### Fixed

- Build `@mariozechner/pi-web-ui` with `tsc` instead of `tsgo` so Lit decorator-based state updates rerender correctly.

## [0.58.2] - 2026-03-15

## [0.58.1] - 2026-03-14

## [0.58.0] - 2026-03-14

## [0.57.1] - 2026-03-07

## [0.57.0] - 2026-03-07

## [0.56.3] - 2026-03-06

## [0.56.2] - 2026-03-05

## [0.56.1] - 2026-03-05

## [0.56.0] - 2026-03-04

## [0.55.4] - 2026-03-02

## [0.55.3] - 2026-02-27

## [0.55.2] - 2026-02-27

## [0.55.1] - 2026-02-26

## [0.55.0] - 2026-02-24

## [0.54.2] - 2026-02-23

## [0.54.1] - 2026-02-22

## [0.54.0] - 2026-02-19

## [0.53.1] - 2026-02-19

## [0.53.0] - 2026-02-17

## [0.52.12] - 2026-02-13

## [0.52.11] - 2026-02-13

## [0.52.10] - 2026-02-12

### Fixed

- Made model selector search case-insensitive by normalizing query tokens, fixing auto-capitalized mobile input filtering ([#1443](https://github.com/badlogic/pi-mono/issues/1443))

## [0.52.9] - 2026-02-08

## [0.52.8] - 2026-02-07

## [0.52.7] - 2026-02-06

## [0.52.6] - 2026-02-05

## [0.52.5] - 2026-02-05

## [0.52.4] - 2026-02-05

## [0.52.3] - 2026-02-05

## [0.52.2] - 2026-02-05

## [0.52.1] - 2026-02-05

## [0.52.0] - 2026-02-05

## [0.51.6] - 2026-02-04

## [0.51.5] - 2026-02-04

## [0.51.4] - 2026-02-03

## [0.51.3] - 2026-02-03

## [0.51.2] - 2026-02-03

## [0.51.1] - 2026-02-02

## [0.51.0] - 2026-02-01

## [0.50.9] - 2026-02-01

## [0.50.8] - 2026-02-01

## [0.50.7] - 2026-01-31

## [0.50.6] - 2026-01-30

## [0.50.5] - 2026-01-30

## [0.50.3] - 2026-01-29

## [0.50.2] - 2026-01-29

### Added

- Exported `CustomProviderCard`, `ProviderKeyInput`, `AbortedMessage`, and `ToolMessageDebugView` components for custom UIs ([#1015](https://github.com/badlogic/pi-mono/issues/1015))

## [0.50.1] - 2026-01-26

## [0.50.0] - 2026-01-26

## [0.49.3] - 2026-01-22

### Changed

- Updated tsgo to 7.0.0-dev.20260120.1 for decorator support ([#873](https://github.com/badlogic/pi-mono/issues/873))

## [0.49.2] - 2026-01-19

## [0.49.1] - 2026-01-18

## [0.49.0] - 2026-01-17

## [0.48.0] - 2026-01-16

## [0.47.0] - 2026-01-16

## [0.46.0] - 2026-01-15

## [0.45.7] - 2026-01-13

## [0.45.6] - 2026-01-13

## [0.45.5] - 2026-01-13

## [0.45.4] - 2026-01-13

## [0.45.3] - 2026-01-13

## [0.45.2] - 2026-01-13

## [0.45.1] - 2026-01-13

## [0.45.0] - 2026-01-13

## [0.44.0] - 2026-01-12

## [0.43.0] - 2026-01-11

## [0.42.5] - 2026-01-11

## [0.42.4] - 2026-01-10

## [0.42.3] - 2026-01-10

## [0.42.2] - 2026-01-10

## [0.42.1] - 2026-01-09

## [0.42.0] - 2026-01-09

## [0.41.0] - 2026-01-09

## [0.40.1] - 2026-01-09

## [0.40.0] - 2026-01-08

## [0.39.1] - 2026-01-08

## [0.39.0] - 2026-01-08

## [0.38.0] - 2026-01-08

## [0.37.8] - 2026-01-07

## [0.37.7] - 2026-01-07

## [0.37.6] - 2026-01-06

## [0.37.5] - 2026-01-06

## [0.37.4] - 2026-01-06

## [0.37.3] - 2026-01-06

## [0.37.2] - 2026-01-05

## [0.37.1] - 2026-01-05

## [0.37.0] - 2026-01-05

## [0.36.0] - 2026-01-05

## [0.35.0] - 2026-01-05

## [0.34.2] - 2026-01-04

## [0.34.1] - 2026-01-04

## [0.34.0] - 2026-01-04

## [0.33.0] - 2026-01-04

## [0.32.3] - 2026-01-03

## [0.32.2] - 2026-01-03

## [0.32.1] - 2026-01-03

## [0.32.0] - 2026-01-03

## [0.31.1] - 2026-01-02

## [0.31.0] - 2026-01-02

### Breaking Changes

- **Agent class moved to `@mariozechner/pi-agent-core`**: The `Agent` class, `AgentState`, and related types are no longer exported from this package. Import them from `@mariozechner/pi-agent-core` instead.

- **Transport abstraction removed**: `ProviderTransport`, `AppTransport`, `AgentTransport` interface, and related types have been removed. The `Agent` class now uses `streamFn` for custom streaming.

- **`AppMessage` renamed to `AgentMessage`**: Now imported from `@mariozechner/pi-agent-core`. Custom message types use declaration merging on `CustomAgentMessages` interface.

- **`UserMessageWithAttachments` is now a custom message type**: Has `role: "user-with-attachments"` instead of `role: "user"`. Use `isUserMessageWithAttachments()` type guard.

- **`CustomMessages` interface removed**: Use declaration merging on `CustomAgentMessages` from `@mariozechner/pi-agent-core` instead.

- **`agent.appendMessage()` removed**: Use `agent.queueMessage()` instead.

- **Agent event types changed**: `AgentInterface` now handles new event types from `@mariozechner/pi-agent-core`: `message_start`, `message_end`, `message_update`, `turn_start`, `turn_end`, `agent_start`, `agent_end`.

### Added

- **`defaultConvertToLlm`**: Default message transformer that handles `UserMessageWithAttachments` and `ArtifactMessage`. Apps can extend this for custom message types.

- **`convertAttachments`**: Utility to convert `Attachment[]` to LLM content blocks (images and extracted document text).

- **`isUserMessageWithAttachments` / `isArtifactMessage`**: Type guard functions for custom message types.

- **`createStreamFn`**: Creates a stream function with CORS proxy support. Reads proxy settings on each call for dynamic configuration.

- **Default `streamFn` and `getApiKey`**: `AgentInterface` now sets sensible defaults if not provided:
  - `streamFn`: Uses `createStreamFn` with proxy settings from storage
  - `getApiKey`: Reads from `providerKeys` storage

- **Proxy utilities exported**: `applyProxyIfNeeded`, `shouldUseProxyForProvider`, `isCorsError`, `createStreamFn`

### Removed

- `Agent` class (moved to `@mariozechner/pi-agent-core`)
- `ProviderTransport` class
- `AppTransport` class
- `AgentTransport` interface
- `AgentRunConfig` type
- `ProxyAssistantMessageEvent` type
- `test-sessions.ts` example file

### Migration Guide

**Before (0.30.x):**
```typescript
import { Agent, ProviderTransport, type AppMessage } from '@mariozechner/pi-web-ui';

const agent = new Agent({
  transport: new ProviderTransport(),
  messageTransformer: (messages: AppMessage[]) => messages.filter(...)
});
```

**After:**
```typescript
import { Agent, type AgentMessage } from '@mariozechner/pi-agent-core';
import { defaultConvertToLlm } from '@mariozechner/pi-web-ui';

const agent = new Agent({
  convertToLlm: (messages: AgentMessage[]) => {
    // Extend defaultConvertToLlm for custom types
    return defaultConvertToLlm(messages);
  }
});
// AgentInterface will set streamFn and getApiKey defaults automatically
```

**Custom message types:**
```typescript
// Before: declaration merging on CustomMessages
declare module "@mariozechner/pi-web-ui" {
  interface CustomMessages {
    "my-message": MyMessage;
  }
}

// After: declaration merging on CustomAgentMessages
declare module "@mariozechner/pi-agent-core" {
  interface CustomAgentMessages {
    "my-message": MyMessage;
  }
}
```
