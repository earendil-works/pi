# Feature Specification: Dart Agent Package

**Feature Branch**: `001-dart-agent-package`
**Created**: 2026-05-09
**Status**: Draft
**Input**: User description: "analyze this repo thoroughly and create a dart package that mirrors the functionality of agent package in the pi monorepo. no need to implement the other packages. only agent is. make it as a pub.dev ready publishable package"

## User Scenarios & Testing

### User Story 1 - Initiate and Manage an AI Agent Conversation (Priority: P1)

A Dart developer wants to embed an AI agent into their Dart/Flutter application. They define a system prompt, select a model, provide tools the agent can use, and start a conversation by sending a user prompt. The agent processes the prompt, may call tools, and returns streaming events that the developer can subscribe to for real-time UI updates.

**Why this priority**: This is the core value proposition. Without the ability to start and run an agent conversation, nothing else matters.

**Independent Test**: Can be fully tested by creating an Agent with a model, tools, and system prompt; sending a prompt; and verifying that events are emitted and the conversation transcript is populated.

**Acceptance Scenarios**:

1. **Given** an initialized Agent with a model, system prompt, and tools, **When** `prompt("Hello")` is called, **Then** the agent emits `agent_start`, `turn_start`, `message_start`, `message_update` (streaming), `message_end`, and optionally tool execution events, followed by `turn_end` and `agent_end`, and the transcript contains the full conversation.

2. **Given** an agent mid-conversation with a toolResult as the last message, **When** `continue()` is called, **Then** the agent resumes the conversation from the current transcript state and produces a valid response.

3. **Given** a running agent, **When** `abort()` is called, **Then** the current run stops, an error message is set, and `waitForIdle()` resolves.

---

### User Story 2 - Define and Execute Custom Tools (Priority: P1)

A developer defines custom tools with strongly-typed parameter schemas and implementations. The agent calls these tools during conversation, and the developer can intercept tool calls (before/after hooks) to modify arguments, inspect results, or terminate the turn early.

**Why this priority**: Tools are what make agents useful beyond simple chatbots. This is fundamental.

**Independent Test**: Create an Agent with a tool, send a prompt that triggers the tool, and verify the tool executes with correct arguments, its result is sent back to the LLM, and hooks fire.

**Acceptance Scenarios**:

1. **Given** an Agent with a registered tool, **When** the LLM decides to call the tool during a turn, **Then** the `beforeToolCall` hook fires, the tool executes, the `afterToolCall` hook fires, and the result is incorporated into the conversation.

2. **Given** multiple tool calls in a single LLM response, **When** `toolExecution` is set to `parallel`, **Then** all tools execute concurrently and results are returned to the LLM in source order.

3. **Given** multiple tool calls and `toolExecution` set to `sequential`, **When** the LLM calls tools, **Then** each tool executes in order, with the output of earlier tools available for later ones.

---

### User Story 3 - Load and Use Skills (Priority: P2)

A developer organizes reusable agent behaviors as SKILL.md files in directories. They load these skills using the package's skill loading utilities, and the system prompt is automatically populated with available skill descriptions so the LLM can invoke them.

**Why this priority**: Skills are a key feature for reusability but build on top of the core agent loop.

**Independent Test**: Create a directory with a SKILL.md, load skills from it, verify they are formatted correctly in the system prompt, and confirm the agent can invoke them.

**Acceptance Scenarios**:

1. **Given** a directory containing SKILL.md files, **When** `loadSkills()` is called, **Then** a list of `Skill` objects is returned with name, description, and source provenance.

2. **Given** loaded skills, **When** the system prompt is generated, **Then** an XML `<available_skills>` block is produced with each skill's details.

---

### User Story 4 - Manage Session Persistence (Priority: P2)

A developer wants conversation history to persist across application restarts. They create a session backed by a storage implementation, append messages as the agent runs, and can later reconstruct the full conversation context from storage.

**Why this priority**: Persistence is essential for production applications but can be added after the core loop works.

**Independent Test**: Create a session backed by in-memory storage, run a conversation, and verify all messages can be read back and reconstructed.

**Acceptance Scenarios**:

1. **Given** a session with storage, **When** messages are appended during an agent conversation, **Then** all message entries are persisted and retrievable by ID.

2. **Given** an existing session with conversation history, **When** `buildContext()` is called, **Then** the full conversation state (messages, model, thinking level) is reconstructed.

3. **Given** a session with tree-based branching, **When** `moveTo(entryId)` is called, **Then** the session navigates to that branch point and subsequent messages are appended as children.

---

### User Story 5 - Configure and Integrate with LLM Providers (Priority: P2)

A developer selects an LLM provider (e.g., OpenAI-compatible, Anthropic) and model. The package manages API key resolution, streaming token generation, and provider-specific request formatting transparently.

**Why this priority**: LLM integration is necessary but a developer can start with a single provider before needing multi-provider support.

**Independent Test**: Configure an Agent with different model identifiers, verify that stream events are emitted correctly, and that provider-specific options are applied.

**Acceptance Scenarios**:

1. **Given** an Agent configured with a specific model and API key, **When** a prompt is sent, **Then** the package formats the request for the correct provider and streams the response back as events.

2. **Given** an Agent with thinking/reasoning capability enabled, **When** a prompt is sent, **Then** thinking content blocks are emitted alongside text content in message events.

---

### User Story 6 - Handle Context Compaction (Priority: P3)

A developer wants long conversations to stay within the model's context window. The package automatically detects when compaction is needed, summarizes old messages, and injects the summary into the conversation so the agent can continue without losing context.

**Why this priority**: Compaction is important for long-running agents but is an optimization feature that comes after the core loop is stable.

**Independent Test**: Run a very long conversation, trigger compaction, and verify old messages are replaced with a summary while the agent continues functioning.

**Acceptance Scenarios**:

1. **Given** a conversation approaching the model's context limit, **When** the compaction threshold is reached, **Then** the agent pauses, summarizes earlier messages, adds a compaction entry to the session, and continues with the compacted context.

2. **Given** a compacted conversation, **When** the agent continues, **Then** the summary is included in the system context and the agent can reference information from before compaction.

---

### User Story 7 - Execute Shell Commands and File Operations (Priority: P3)

A developer provides an execution environment abstraction that the agent uses to run shell commands, read/write files, and interact with the filesystem. The package includes a local implementation for Dart's VM environment.

**Why this priority**: Shell/file operations are critical for coding agents but can be provided as an environment implementation rather than core logic.

**Independent Test**: Create an execution environment, run a shell command, read a file, and verify output, exit codes, and errors are handled correctly.

**Acceptance Scenarios**:

1. **Given** an execution environment, **When** a shell command is executed, **Then** stdout, stderr, and exit code are captured and returned.

2. **Given** an execution environment, **When** a non-existent file is read, **Then** a typed error with an error code is thrown.

---

### Edge Cases

- What happens when the LLM returns an empty or malformed response?
- How does the agent handle tool execution failures (exceptions during execute)?
- What happens when abort() is called while tools are executing?
- How does the agent behave when all tools fail in a turn?
- What happens when a session storage operation fails (disk full, permissions)?
- How does the agent handle extremely long tool outputs that exceed the model's context?
- What happens when getApiKey returns undefined?
- How does the agent handle concurrent prompts when already running?

## Requirements

### Functional Requirements

- **FR-001**: System MUST provide an Agent class that manages conversation state, tool execution, and event emission
- **FR-002**: System MUST support both starting a new conversation (prompt) and continuing an existing one (continue)
- **FR-003**: System MUST emit typed events for all lifecycle stages: agent start/end, turn start/end, message streaming, and tool execution
- **FR-004**: System MUST support subscribing to agent events and awaiting all listener callbacks before marking the agent as idle
- **FR-005**: System MUST support defining tools with strongly-typed parameter schemas and validation
- **FR-006**: System MUST support both parallel and sequential tool execution modes globally and per-tool
- **FR-007**: System MUST provide beforeToolCall and afterToolCall hooks for intercepting tool invocations
- **FR-008**: System MUST support steering messages (mid-turn injection) and follow-up messages (post-turn injection) into the conversation
- **FR-009**: System MUST support aborting a running agent and waiting for cleanup to complete
- **FR-010**: System MUST expose a read-only AgentState with messages, tools, systemPrompt, model, thinking level, and streaming status
- **FR-011**: System MUST support converting agent-level messages to LLM-compatible messages, with customizable conversion
- **FR-012**: System MUST support a transformContext hook for message preprocessing before each LLM call
- **FR-013**: System MUST support loading SKILL.md files from directories and formatting them for system prompts
- **FR-014**: System MUST support loading prompt template (.md) files with argument substitution
- **FR-015**: System MUST provide a Session abstraction with tree-of-entries for persistent conversation storage
- **FR-016**: System MUST support session branching (moveTo) for exploring alternate conversation paths
- **FR-017**: System MUST provide both in-memory and file-based session storage implementations
- **FR-018**: System MUST support context compaction with automated summary generation to stay within model context limits
- **FR-019**: System MUST provide an ExecutionEnv abstraction for filesystem and shell operations
- **FR-020**: System MUST support configurable LLM provider and model selection with API key resolution
- **FR-021**: System MUST support thinking/reasoning content alongside standard text responses
- **FR-022**: System MUST support session-level metadata including model changes, thinking level changes, and labels
- **FR-023**: System MUST handle streaming responses with partial content updates
- **FR-024**: The package MUST have no runtime dependencies on Node.js or JavaScript-specific APIs
- **FR-025**: The package MUST be published to pub.dev with complete API documentation, example usage, and a README

### Key Entities

- **Agent**: Stateful wrapper managing the conversation lifecycle, tool registry, event emissions, and message queues. Owns AgentState and delegates to the low-level loop.
- **AgentState**: Immutable snapshot of current agent context including system prompt, model, thinking level, conversation transcript, registered tools, streaming status, pending tool calls, and error state.
- **AgentTool**: Typed tool definition combining a parameter schema (with validation), an execute function, optional argument preparation, and execution mode preference.
- **AgentEvent**: Discriminated union of lifecycle events emitted during agent runs (agent_start, turn_start, message_start/update/end, tool_execution_start/update/end, agent_end).
- **AgentContext**: Snapshot of context sent to the LLM: system prompt, formatted messages, and active tools.
- **AgentLoopConfig**: Configuration for the low-level agent loop including model, tool execution mode, hooks (beforeToolCall, afterToolCall, shouldStopAfterTurn), and message injection callbacks (getSteeringMessages, getFollowUpMessages).
- **Session**: Tree-of-entries data model storing conversation history with support for branching, compaction summaries, model/thinking changes, and context reconstruction.
- **SessionTreeEntry**: Node in the session tree representing a message, compaction event, model change, thinking level change, label, or custom entry.
- **Skill**: Reusable agent behavior defined by a SKILL.md file with name, description, and invocation format.
- **PromptTemplate**: Parameterized prompt template loaded from .md files with named argument substitution.
- **ExecutionEnv**: Filesystem and shell execution abstraction providing read/write/list/remove file operations and command execution with output capture.

## Success Criteria

### Measurable Outcomes

- **SC-001**: A developer can create an Agent, register tools, send a prompt, and receive a complete response in under 30 seconds (excluding LLM latency)
- **SC-002**: The package passes `dart analyze` with zero errors, warnings, or hints
- **SC-003**: All public API members have dartdoc documentation comments
- **SC-004**: The package has at least 80% test coverage across core library files
- **SC-005**: A developer can integrate the package into a new Dart project with a single `dart pub add` command and send their first prompt within 5 minutes
- **SC-006**: The package compiles and runs correctly on the Dart VM (native) and when compiled to native executables
- **SC-007**: Session persistence survives process restart with no data loss

## Assumptions

- The Dart package targets Dart SDK >= 3.0.0 (for records, sealed classes, and pattern matching)
- LLM provider communication uses HTTP streaming (SSE or similar); the package does not implement raw TCP/TLS
- The package includes its own lightweight type validation (parameter schemas). It does not depend on the TypeScript `typebox` library equivalent
- Tool parameter schemas use a JSON Schema-compatible description format
- Skills are stored as markdown files with YAML frontmatter, following the same format as the source pi agent package
- Session storage uses JSON Lines (JSONL) format for file-based persistence, matching the source package
- The Dart project will not have its own `ai` subpackage; the agent package will directly consume LLM APIs or depend on a Dart AI client library
- The package does not need to mirror the AgentHarness class (which is a higher-level orchestrator specific to the pi CLI application)
- The package does not need to mirror the proxy streaming functionality (which is server-side routing logic)
- YAML frontmatter parsing uses the public `yaml` package from pub.dev
