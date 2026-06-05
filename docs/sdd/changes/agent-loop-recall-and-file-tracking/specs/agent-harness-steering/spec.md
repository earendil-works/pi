# agent-harness-steering Specification

## MODIFIED Requirements

### Requirement: Steer triggers before_agent_start

The `steer()` method on `AgentHarness` SHALL emit the `before_agent_start` hook before pushing the message to the steering queue, so that extensions listening on `before_agent_start` (e.g., memory recall) can react to the new user message as a fresh prompt topic.

#### Scenario: Steer emits before_agent_start with steer text as prompt
- **GIVEN** AgentHarness is in non-idle phase
- **AND** a test extension is registered that subscribes to `before_agent_start`
- **WHEN** user calls `harness.steer("看下 cron 模块性能")`
- **THEN** the extension's `before_agent_start` handler is called
- **AND** the event's `prompt` field equals `"看下 cron 模块性能"`
- **AND** the event's `systemPrompt` is the current harness system prompt (unchanged)
- **AND** the steer message is pushed to `steerQueue` for the next LLM turn to process

#### Scenario: Steer does not block when no extension listens
- **GIVEN** AgentHarness is in non-idle phase
- **AND** no extension is registered for `before_agent_start`
- **WHEN** user calls `harness.steer("any text")`
- **THEN** the call returns without throwing
- **AND** the steer message is in `steerQueue`

#### Scenario: Steer overwrites pending memory search
- **GIVEN** a previous `before_agent_start` already set `pendingMemorySearch = { promise: P1, ... }`
- **AND** P1 has not yet been consumed
- **WHEN** user calls `harness.steer("new topic")`
- **THEN** `pendingMemorySearch` is set to a new `{ promise: P2, ... }`
- **AND** P1's eventual resolution is silently discarded (its result is never injected into context)
- **AND** P2's result is injected (via the existing `context` hook consumption path) when the next LLM call processes the steer message
