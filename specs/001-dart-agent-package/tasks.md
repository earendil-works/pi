# Tasks: Dart Agent Package

**Input**: Design documents from `specs/001-dart-agent-package/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Included per SC-004 (80%+ test coverage required for pub.dev readiness).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Include exact file paths in descriptions

## Path Conventions

- Package root at `pi_agent/` (separate Dart package from the TypeScript monorepo)
- Source code: `pi_agent/lib/` (public barrel) and `pi_agent/lib/src/` (implementation)
- Tests: `pi_agent/test/`
- Example: `pi_agent/example/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Initialize the Dart package with all required configuration files

- [X] T001 Create `pi_agent/pubspec.yaml` with package name `pi_agent`, version `0.1.0`, description (60-180 chars), SDK constraint `>=3.0.0`, dependencies (`http`, `yaml`), devDependencies (`test`, `lints`)
- [X] T002 [P] Create `pi_agent/analysis_options.yaml` with `include: package:lints/dart.yaml` plus `public_member_api_docs` rule
- [X] T003 [P] Create `pi_agent/LICENSE` with BSD 3-Clause license text
- [X] T004 [P] Create `pi_agent/CHANGELOG.md` with initial `## 0.1.0` entry
- [X] T005 [P] Create `pi_agent/README.md` with package description, installation instructions, and link to example
- [X] T006 Create `pi_agent/.gitignore` with standard Dart entries (`.dart_tool/`, `build/`, `.packages`, `pubspec.lock`)
- [X] T007 Run `dart pub get` in `pi_agent/` and verify zero analysis errors with `dart analyze`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core types, sealed class hierarchies, and LLM client that ALL user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

- [X] T008 [P] Implement ContentBlock sealed class hierarchy in `pi_agent/lib/src/types.dart` — TextBlock, ImageBlock with const constructors and required fields
- [X] T009 [P] Implement ThinkingLevel and ToolExecutionMode enums in `pi_agent/lib/src/types.dart`
- [X] T010 [P] Implement Model class in `pi_agent/lib/src/types.dart` — provider, modelId, contextWindow, supportsVision, supportsThinking, supportsTools fields
- [X] T011 [P] Implement Usage class in `pi_agent/lib/src/types.dart` — inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens
- [X] T012 [P] Implement StopReason enum in `pi_agent/lib/src/types.dart` — endTurn, maxTokens, toolUse, stopSequence, refused
- [X] T013 [P] Implement AgentMessage sealed class hierarchy in `pi_agent/lib/src/types.dart` — UserMessage (List<ContentBlock> content), AssistantMessage (String? id, List<dynamic> content, StopReason? stopReason, Usage? usage), ToolResultMessage (String toolCallId, String toolName, List<ContentBlock> content, bool isError)
- [X] T014 [P] Implement stream types and typedefs in `pi_agent/lib/src/types.dart` — StreamFn, MessageConverter, ContextTransformer, ApiKeyResolver, StopCondition, MessageProvider, BeforeToolCallHook, AfterToolCallHook type aliases
- [X] T015 [P] Implement SSE parser in `pi_agent/lib/src/sse_parser.dart` — parseSSE() function accepting Stream<List<int>> and returning Stream<Map<String, String>> with full SSE spec handling (data, event, id, retry, comment lines, multi-line data coalescing)
- [X] T016 Implement LLM client function in `pi_agent/lib/src/llm_client.dart` — streamLLM() function: accepts Model, messages, tools, apiKey, abortSignal; returns Stream<AgentMessage>; handles OpenAI-compatible and Anthropic API formats; includes error handling for non-2xx responses
- [X] T017 [P] Implement message conversion in `pi_agent/lib/src/conversion.dart` — convertToLlm() default implementation filtering AgentMessage[] to LLM-compatible Message[], converting custom message types to text representation
- [X] T018 Implement barrel export file `pi_agent/lib/pi.dart` exporting all public API from `lib/src/` files (populate as files are created)
- [X] T019 [P] Write tests for SSE parser in `pi_agent/test/sse_parser_test.dart` — test single events, multi-line data, comments, incomplete chunks, [DONE] signal
- [X] T020 [P] Write tests for types in `pi_agent/test/types_test.dart` — verify sealed class exhaustiveness, const construction, ContentBlock equality

**Checkpoint**: Foundation ready — all core types, LLM client, and SSE parser are functional. User story implementation can now begin.

---

## Phase 3: User Story 5 - Configure and Integrate with LLM Providers (Priority: P2 -- EARLY due to technical dependency)

**Goal**: LLM provider integration is needed by all other stories. Developer can configure models, resolve API keys, and stream responses.

**Independent Test**: Configure a model, send a raw streaming request, verify SSE events are parsed into AgentMessage stream.

### Tests for User Story 5

- [X] T021 [P] [US5] Write tests for LLM client in `pi_agent/test/llm_client_test.dart` — test OpenAI format request, Anthropic format request, error response handling, abort/cancellation, streaming chunk assembly

### Implementation for User Story 5

- [X] T022 [US5] Implement OpenAI provider request formatting in `pi_agent/lib/src/llm_client.dart` — buildRequest() method: messages → ChatCompletions format, tools → function definitions, system prompt injection, streaming=true header
- [X] T023 [US5] Implement Anthropic provider request formatting in `pi_agent/lib/src/llm_client.dart` — buildAnthropicRequest(): messages → Messages API format, tools → tool definitions, system prompt as top-level param
- [X] T024 [US5] Implement streaming response parsing in `pi_agent/lib/src/llm_client.dart` — parseOpenAIChunk(): extracts text delta, thinking delta, tool call chunks; emits message update events
- [X] T025 [US5] Implement Anthropic streaming response parsing in `pi_agent/lib/src/llm_client.dart` — parseAnthropicChunk(): content_block_start/delta/stop, message_start/delta/stop events
- [X] T026 [US5] Implement ApiKeyResolver integration in `pi_agent/lib/src/llm_client.dart` — call getApiKey(provider) before each request, error if undefined
- [X] T027 [US5] Implement AbortableRequest integration in `pi_agent/lib/src/llm_client.dart` — Completer<void> → AbortableRequest.abortTrigger, handle RequestAbortedException
- [X] T028 [US5] Update barrel export `pi_agent/lib/pi.dart` to export LLM client types

**Checkpoint**: LLM streaming works for at least OpenAI-compatible and Anthropic providers.

---

## Phase 4: User Story 1 - Initiate and Manage an AI Agent Conversation (Priority: P1) 🎯 MVP

**Goal**: Developer can create an Agent, send prompts, receive streaming events, and continue conversations.

**Independent Test**: Create an Agent with model + system prompt, call prompt("Hello"), verify all AgentEvent types are emitted in correct order, transcript populated.

### Tests for User Story 1

- [X] T029 [P] [US1] Write Agent class tests in `pi_agent/test/agent_test.dart` — construction, default state, initial state override, prompt lifecycle, continue lifecycle, abort lifecycle, event subscription, waitForIdle, concurrent prompt rejection, reset
- [X] T030 [P] [US1] Write agent loop tests in `pi_agent/test/agent_loop_test.dart` — event emission ordering, steering message injection, follow-up message injection, transformContext hook, shouldStopAfterTurn, abort handling

### Implementation for User Story 1

- [X] T031 [P] [US1] Implement AgentState class in `pi_agent/lib/src/types.dart` — systemPrompt, model, thinkingLevel, _tools (with getter), _messages (with getter), isStreaming, streamingMessage, pendingToolCalls, errorMessage fields; tools setter copies array, messages setter copies array
- [X] T032 [P] [US1] Implement AgentEvent sealed class hierarchy in `pi_agent/lib/src/types.dart` — AgentStart (sessionId?), AgentEnd (messages), TurnStart, TurnEnd (message, toolResults), MessageStart (message), MessageUpdate (message), MessageEnd (message), ToolExecutionStart (toolCallId, toolName, args), ToolExecutionUpdate (toolCallId, toolName, args, partialResult), ToolExecutionEnd (toolCallId, toolName, args, result, isError)
- [X] T033 [P] [US1] Implement AgentContext class in `pi_agent/lib/src/types.dart` — systemPrompt, messages, tools
- [X] T034 [P] [US1] Implement AgentLoopConfig class in `pi_agent/lib/src/types.dart` — model, maxTokens?, temperature?, topP?, toolExecution, convertToLlm, transformContext?, getApiKey?, shouldStopAfterTurn?, getSteeringMessages?, getFollowUpMessages?, beforeToolCall?, afterToolCall?
- [X] T035 [US1] Implement low-level agentLoop() function in `pi_agent/lib/src/agent_loop.dart` — accepts AgentContext + AgentLoopConfig, returns Stream<AgentEvent>: call LLM via streamFn, emit MessageStart/MessageUpdate/MessageEnd for each streaming chunk, emit ToolExecutionStart/Update/End for each tool call, check shouldStopAfterTurn, inject steering messages, run follow-up loop
- [X] T036 [US1] Implement agentLoopContinue() function in `pi_agent/lib/src/agent_loop.dart` — same as agentLoop but from existing context (no initial user message injection)
- [X] T037 [US1] Implement runAgentLoop() and runAgentLoopContinue() async wrappers in `pi_agent/lib/src/agent_loop.dart` — consume stream, return List<AgentMessage>
- [X] T038 [US1] Implement cancelable run abstraction in `pi_agent/lib/src/agent_loop.dart` — ActiveRun class wrapping Completer<void> abortSignal, StreamSubscription, and run state tracking
- [X] T039 [US1] Implement Agent class in `pi_agent/lib/src/agent.dart` — constructor accepting AgentOptions, state property (read-only AgentState getter), prompt() method (initiates new conversation), continue_() method (resumes from transcript), steer() method (queues steering messages), followUp() method (queues follow-up messages), abort() method (cancels active run), waitForIdle() method (awaits run completion + listener settlement), reset() method (clears transcript/queues), subscribe() method (returns void Function() unsubscribe)
- [X] T040 [US1] Implement steering/follow-up message queues in `pi_agent/lib/src/agent.dart` — PendingMessageQueue class with push/clear methods, steeringMode (all/oneAtATime), followUpMode (all/oneAtATime)
- [X] T041 [US1] Implement Agent event subscription system in `pi_agent/lib/src/agent.dart` — List<AgentEventListener>, emit events sequentially awaiting each listener, track pending listener futures for waitForIdle
- [X] T042 [US1] Implement Agent message queue integration in `pi_agent/lib/src/agent.dart` — after turn complete, check steering queue → inject into next turn; after outer loop complete, check follow-up queue → start new outer loop
- [X] T043 [US1] Update barrel export `pi_agent/lib/pi.dart` to export Agent, AgentState, AgentEvent, AgentLoopConfig

**Checkpoint**: Agent can start conversations, stream responses, handle abort, and support steering/follow-up. MVP complete.

---

## Phase 5: User Story 2 - Define and Execute Custom Tools (Priority: P1)

**Goal**: Developer defines tools with typed parameter schemas. Agent calls them during conversation with parallel/sequential execution and before/after hooks.

**Independent Test**: Create Agent with a tool, prompt that triggers the tool, verify tool executes with correct args and result is returned to LLM.

### Tests for User Story 2

- [X] T044 [P] [US2] Write tool validation tests in `pi_agent/test/tools_test.dart` — valid parameters pass, invalid type rejected, missing required field rejected, enum validation, nested object validation, prepareArguments transformation

### Implementation for User Story 2

- [X] T045 [P] [US2] Implement AgentToolResult class in `pi_agent/lib/src/types.dart` — content (List<ContentBlock>), details (T), terminate (bool)
- [X] T046 [P] [US2] Implement AgentTool class in `pi_agent/lib/src/tools.dart` — name, description, parameters (JSON Schema Map), label, prepareArguments?, execute async function (receives toolCallId, params, onUpdate callback, isAborted callback), executionMode?
- [X] T047 [P] [US2] Implement parameter validation in `pi_agent/lib/src/tools.dart` — validateParameters(Map schema, Map values): validates type, properties, required, enum, items; returns List<String>? errors or null on success
- [X] T048 [US2] Implement tool execution in agent loop — in `pi_agent/lib/src/agent_loop.dart`: after MessageEnd with tool calls, iterate tool calls, call beforeToolCall hook (allow arg mutation), validate via prepareArguments + validateParameters, execute in parallel (Future.wait) or sequential (for-await), call afterToolCall hook, emit ToolExecutionStart/Update/End events, collect toolResult messages, inject back into loop
- [X] T049 [US2] Implement per-tool executionMode override in agent loop — check tool.executionMode before dispatching, respect tool-level override over global config
- [X] T050 [US2] Implement terminate:true handling in agent loop — if any tool result has terminate=true, skip follow-up LLM call for that batch, but allow remaining tools to complete
- [X] T051 [US2] Add tool execution tests to `pi_agent/test/agent_loop_test.dart` — parallel execution ordering (events in completion order, results in source order), sequential execution ordering, per-tool mode override, beforeToolCall arg mutation, afterToolCall terminate, tool execution failure (exception in execute), empty tool result

**Checkpoint**: Agent can execute tools with parameter validation, parallel/sequential modes, and hooks.

---

## Phase 6: User Story 3 - Load and Use Skills (Priority: P2)

**Goal**: Developer loads SKILL.md files from directories and they are formatted into system prompts.

**Independent Test**: Create dir with SKILL.md, load skills, verify formatting in system prompt XML.

### Tests for User Story 3

- [X] T052 [P] [US3] Write skill loading tests in `pi_agent/test/skills_test.dart` — load from directory, verify name/description/content fields, symlinked directories, missing directory error, malformed YAML diagnostic, hidden skill filtering, empty directory returns empty list
- [X] T053 [P] [US3] Write skill formatting tests in `pi_agent/test/skills_test.dart` — formatSkillsForSystemPrompt generates correct XML, XML escaping for special chars (`, <, &), formatSkillInvocation

### Implementation for User Story 3

- [X] T054 [P] [US3] Implement Skill class in `pi_agent/lib/src/types.dart` — name, description, content, invocation?, hidden, sourcePath, diagnostics
- [X] T055 [P] [US3] Implement SkillDiagnostic class in `pi_agent/lib/src/skills.dart` — level (warning/error enum), message, sourcePath?
- [X] T056 [US3] Implement YAML frontmatter parsing in `pi_agent/lib/src/skills.dart` — parseFrontmatter(String content): extracts YAML between `---` delimiters, returns Map<String, dynamic> and body text
- [X] T057 [US3] Implement loadSkills() in `pi_agent/lib/src/skills.dart` — loadSkills(List<String> directories, {bool followSymlinks = true}): walks each directory, reads .md files with YAML frontmatter, parses name/description/hidden/invocation from frontmatter, returns List<Skill>
- [X] T058 [US3] Implement loadSourcedSkills<T>() in `pi_agent/lib/src/skills.dart` — accepts List<({T source, String directory})>, returns List<Skill> with source provenance
- [X] T059 [US3] Implement formatSkillsForSystemPrompt() in `pi_agent/lib/src/skills.dart` — generates `<available_skills>` XML block with `<skill>` entries for non-hidden skills, includes name, description, location
- [X] T060 [US3] Implement formatSkillInvocation() in `pi_agent/lib/src/skills.dart` — formats skill as prompt text for explicit invocation
- [X] T061 [US3] Update barrel export `pi_agent/lib/pi.dart` to export Skill, SkillDiagnostic, loadSkills, loadSourcedSkills, formatSkillsForSystemPrompt, formatSkillInvocation

**Checkpoint**: Skills can be loaded from directories and formatted for system prompts.

---

## Phase 7: User Story 4 - Manage Session Persistence (Priority: P2)

**Goal**: Conversation history persists via Session with tree-of-entries structure supporting branching.

**Independent Test**: Create session, append messages, rebuild context, verify full history reconstructed.

### Tests for User Story 4

- [X] T062 [P] [US4] Write session storage tests in `pi_agent/test/session_storage_test.dart` — InMemorySessionStorage: append/load entries, findEntry, leaf tracking, set/get metadata. JsonlSessionStorage: create file, append/load, malformed line skipping, header metadata resilience
- [X] T063 [P] [US4] Write session tests in `pi_agent/test/session_test.dart` — appendMessage, buildContext (message reconstruction), appendThinkingLevelChange, appendModelChange, moveTo (branching), appendLabel, getBranch (path to root), appendCompaction (summary + firstKeptEntryId)

### Implementation for User Story 4

- [X] T064 [P] [US4] Implement SessionTreeEntry sealed class hierarchy in `pi_agent/lib/src/types.dart` — base with id, parentId, timestamp; MessageEntry (role, message), ThinkingLevelChangeEntry (level), ModelChangeEntry (provider, modelId), CompactionEntry (summary, firstKeptEntryId, tokensBefore), LabelEntry (targetId, label?), CustomEntry (customType, data?)
- [X] T065 [P] [US4] Implement SessionInfo class in `pi_agent/lib/src/types.dart` — id, name, createdAt, updatedAt, metadata
- [X] T066 [P] [US4] Implement SessionContext class in `pi_agent/lib/src/types.dart` — messages (List<AgentMessage>), thinkingLevel (ThinkingLevel), model (Model)
- [X] T067 [P] [US4] Implement SessionStorage interface in `pi_agent/lib/src/session.dart` — init(), appendEntry(SessionTreeEntry), loadEntries(), findEntry(String), setLeafId(String?), getLeafId(), setMetadata(SessionInfo), getMetadata(), close()
- [X] T068 [US4] Implement InMemorySessionStorage in `pi_agent/lib/src/session_storage.dart` — entries as List<SessionTreeEntry>, leafId as String?, metadata as SessionInfo, all operations synchronous with Futures
- [X] T069 [US4] Implement JsonlSessionStorage in `pi_agent/lib/src/session_storage.dart` — filePath, JSON encode/decode each line, header line with metadata as first entry, atomic append via writeAsStringSync, lazy loading, malformed line recovery (skip + warn)
- [X] T070 [US4] Implement Session class in `pi_agent/lib/src/session.dart` — constructor(SessionStorage), _leafId, appendMessage (creates MessageEntry + links to parent via leafId), appendThinkingLevelChange, appendModelChange, appendCompaction, appendLabel, appendCustomEntry, buildContext (walks tree from leaf to root, reconstructs messages/thinking/model considering compaction cuts), getBranch, moveTo (sets leafId to target, returns optional summary), getEntries, getEntry, getMetadata
- [X] T071 [US4] Implement Session buildContext reconstruction logic in `pi_agent/lib/src/session.dart` — walk from leafId to root via parentId chain, collect messages, stop at compaction entries (use summary instead of full history), track model/thinking changes (most recent wins)
- [X] T072 [US4] Update barrel export `pi_agent/lib/pi.dart` to export Session, SessionStorage, InMemorySessionStorage, JsonlSessionStorage, SessionTreeEntry variants, SessionContext, SessionInfo

**Checkpoint**: Sessions persist conversation history with branching and context reconstruction.

---

## Phase 8: User Story 6 - Handle Context Compaction (Priority: P3)

**Goal**: Long conversations are automatically compacted to stay within context window.

**Independent Test**: Build large conversation, trigger compaction, verify summary generated and old messages replaced.

### Tests for User Story 6

- [X] T073 [P] [US6] Write compaction tests in `pi_agent/test/compaction_test.dart` — calculateContextTokens, estimateContextTokens, shouldCompact threshold, findCutPoint, serializeConversation, prepareCompaction with previousSummary, compact result verification

### Implementation for User Story 6

- [X] T074 [P] [US6] Implement CompactionSettings class in `pi_agent/lib/src/compaction.dart` — enabled, reserveTokens, keepRecentTokens fields with defaults
- [X] T075 [US6] Implement token estimation in `pi_agent/lib/src/compaction.dart` — calculateContextTokens(Usage): from usage object; estimateContextTokens(List<AgentMessage>): chars/4 heuristic when usage unavailable; estimateTokens(AgentMessage): per-role heuristic
- [X] T076 [US6] Implement shouldCompact() in `pi_agent/lib/src/compaction.dart` — compare estimated tokens to (contextWindow - reserveTokens), return true if exceeded
- [X] T077 [US6] Implement findCutPoint() in `pi_agent/lib/src/compaction.dart` — walk entries from leaf backwards, accumulate tokens until >= keepRecentTokens, return entryId at cut point
- [X] T078 [US6] Implement serializeConversation() in `pi_agent/lib/src/compaction.dart` — convert List<AgentMessage> to plain text with role labels for summarization
- [X] T079 [US6] Implement generateSummary() in `pi_agent/lib/src/compaction.dart` — call LLM (via completeSimple-style non-streaming call) with system prompt asking for conversation summary, return String summary
- [X] T080 [US6] Implement prepareCompaction() in `pi_agent/lib/src/compaction.dart` — identify cut point, collect entries before/after cut, serialize cut entries for summarization, return CompactionPreparation
- [X] T081 [US6] Implement compact() in `pi_agent/lib/src/compaction.dart` — full compaction flow: findCutPoint → serializeConversation → generateSummary → return CompactionResult with summary, firstKeptEntryId, tokensBefore
- [X] T082 [US6] Update barrel export `pi_agent/lib/pi.dart` to export CompactionSettings, compaction functions

**Checkpoint**: Context compaction works with automated summarization.

---

## Phase 9: User Story 7 - Execute Shell Commands and File Operations (Priority: P3)

**Goal**: Execution environment abstraction for shell commands and filesystem operations.

**Independent Test**: Create NodeExecutionEnv, run command, read file, verify output capture and error handling.

### Tests for User Story 7

- [X] T083 [P] [US7] Write execution env tests in `pi_agent/test/execution_env_test.dart` — file read/write/list/remove, fileInfo for files/dirs, symlink handling, FileError for missing paths, exec stdout/stderr/exitCode capture, exec abort

### Implementation for User Story 7

- [X] T084 [P] [US7] Implement FileKind enum + FileInfo class in `pi_agent/lib/src/execution_env.dart` — FileKind.file, FileKind.directory, FileKind.symlink; FileInfo: path, kind, size, modified
- [X] T085 [P] [US7] Implement FileError class + FileErrorCode enum in `pi_agent/lib/src/execution_env.dart` — FileError(String path, FileErrorCode code, String message); FileErrorCode: notFound, notDirectory, permissionDenied, ioError
- [X] T086 [P] [US7] Implement ShellResult class in `pi_agent/lib/src/execution_env.dart` — stdout (String), stderr (String), exitCode (int)
- [X] T087 [P] [US7] Implement ExecutionEnv interface in `pi_agent/lib/src/execution_env.dart` — abstract class with readFile, writeFile, listDirectory, removeFile, fileInfo, fileExists, exec (with workingDirectory?, environment?, isAborted?), createTempFile, createTempDirectory
- [X] T088 [US7] Implement LocalExecutionEnv in `pi_agent/lib/src/execution_env.dart` — uses dart:io for file operations (readAsStringSync, writeAsStringSync, Directory.listSync, FileSystemEntity.deleteSync, FileStat.statSync, Process.run/start), temp via Directory.systemTemp
- [X] T089 [US7] Implement shell output capture with truncation in `pi_agent/lib/src/execution_env.dart` — executeShellWithCapture(): stream Process stdout/stderr, capture with maxLines/maxBytes limits, truncateHead/truncateTail when exceeded, spill full output to temp file
- [X] T090 [US7] Implement truncation utilities in `pi_agent/lib/src/execution_env.dart` — truncateHead(String text, {maxLines?, maxBytes?}), truncateTail(String text, {maxLines?, maxBytes?}), formatSize(int bytes) → "1.2KB", DEFAULT_MAX_LINES = 2000, DEFAULT_MAX_BYTES = 51200
- [X] T091 [US7] Update barrel export `pi_agent/lib/pi.dart` to export ExecutionEnv, LocalExecutionEnv, FileError, FileErrorCode, FileInfo, FileKind, ShellResult, truncation utilities

**Checkpoint**: Execution environment with local implementation works for file and shell operations.

---

## Phase 10: User Story 3.5 - Prompt Templates (Priority: P2)

**Goal**: Developer loads parameterized prompt templates from .md files with argument substitution.

**Independent Test**: Load template file, substitute args, verify output.

### Tests for Prompt Templates

- [X] T092 [P] [US3] Write prompt template tests in `pi_agent/test/prompt_templates_test.dart` — load from directory, file name → template name, arg substitution ($1, $@, $ARGUMENTS, ${@:N}), symlinked templates, parseCommandArgs utility

### Implementation for Prompt Templates

- [X] T093 [P] [US3] Implement PromptTemplate class in `pi_agent/lib/src/types.dart` — name, description, content, args, sourcePath
- [X] T094 [P] [US3] Implement PromptTemplateDiagnostic class in `pi_agent/lib/src/prompt_templates.dart` — level, message, sourcePath?
- [X] T095 [US3] Implement loadPromptTemplates() in `pi_agent/lib/src/prompt_templates.dart` — walk directories, read .md files with YAML frontmatter, parse name/description/args from frontmatter
- [X] T096 [US3] Implement loadSourcedPromptTemplates<T>() in `pi_agent/lib/src/prompt_templates.dart` — accept List<({T source, String path})>, return List<PromptTemplate> with source provenance
- [X] T097 [US3] Implement substituteArgs() in `pi_agent/lib/src/prompt_templates.dart` — handle $1..$N positional args, $@ all args joined, $ARGUMENTS full raw input, ${@:N} select args from position N onward
- [X] T098 [US3] Implement parseCommandArgs() in `pi_agent/lib/src/prompt_templates.dart` — shell-style quoted argument parsing with escape support
- [X] T099 [US3] Implement formatPromptTemplateInvocation() in `pi_agent/lib/src/prompt_templates.dart` — substitute args into template content, return rendered String
- [X] T100 [US3] Update barrel export `pi_agent/lib/pi.dart` to export PromptTemplate, prompt template loading/formatting functions

**Checkpoint**: Prompt templates with argument substitution work.

---

## Phase 11: Polish & Cross-Cutting Concerns

**Purpose**: pub.dev readiness, documentation, and final quality checks

- [X] T101 [P] Write `pi_agent/example/main.dart` — complete standalone example demonstrating Agent creation, tool registration, skill loading, session persistence, and continuing conversations
- [X] T102 [P] Add dartdoc comments to all public API members in `pi_agent/lib/src/` (target 100% public API documentation coverage)
- [X] T103 [P] Generate and verify dartdoc output with `dart doc` in `pi_agent/` — ensure no warnings or broken references
- [X] T104 Run `dart format .` in `pi_agent/` to ensure consistent formatting
- [X] T105 Run `dart analyze` in `pi_agent/` and fix all errors, warnings, and info-level diagnostics
- [X] T106 Run `dart test` in `pi_agent/` and ensure all tests pass with 80%+ coverage
- [X] T107 Verify `dart pub publish --dry-run` succeeds in `pi_agent/`
- [X] T108 Validate quickstart.md scenarios by running example code from `pi_agent/example/main.dart`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories
- **US5 LLM Providers (Phase 3)**: Depends on Foundational — BLOCKS US1
- **US1 Agent (Phase 4)**: Depends on US5 (needs LLM client to function) — P1 MVP
- **US2 Tools (Phase 5)**: Depends on US1 (needs agent loop for tool execution)
- **US3 Skills (Phase 6)**: Depends on Foundational only — can run in parallel with US1/US2
- **US4 Session (Phase 7)**: Depends on Foundational only — can run in parallel with US3
- **US6 Compaction (Phase 8)**: Depends on US4 (needs session entries) + US5 (needs LLM for summaries)
- **US7 Exec Env (Phase 9)**: Depends on Foundational only — can run in parallel with US3/US4
- **US3.5 Templates (Phase 10)**: Depends on US3 (shares skills/templates loading pattern)
- **Polish (Phase 11)**: Depends on all user stories being complete

### User Story Dependency Graph

```
Setup (Phase 1)
  └── Foundational (Phase 2)
        ├── US5: LLM Providers (Phase 3)
        │     └── US1: Agent (Phase 4)
        │           └── US2: Tools (Phase 5)
        ├── US3: Skills (Phase 6) ──┐
        ├── US4: Session (Phase 7) ──┼── US6: Compaction (Phase 8)
        └── US7: Exec Env (Phase 9) ─┘
              └── US3.5: Templates (Phase 10)
                    └── Polish (Phase 11)
```

### Within Each User Story

- Tests written FIRST, verified to fail, then implementation
- Types/models before logic
- Core implementation before integration
- Barrel export updated after all source files complete

### Parallel Opportunities

Within Phase 2 (Foundational): T008-T015, T017 all [P] — different types in shared file or different files
Within Phase 4 (US1): T031-T034 [P] — types can be written in parallel
Within Phase 5 (US2): T045-T047 [P] — AgentToolResult, AgentTool, validation are independent
Within Phase 7 (US4): T064-T067 [P] — entry types, session types, storage interface
Within Phase 9 (US7): T084-T087 [P] — all type/interface definitions
Across phases: US3, US4, US7 can be implemented in parallel after Foundational

---

## Parallel Example: User Story 1

```bash
# Launch all type definitions for US1 in parallel:
Task: "Implement AgentState class in pi_agent/lib/src/types.dart"
Task: "Implement AgentEvent sealed class hierarchy in pi_agent/lib/src/types.dart"
Task: "Implement AgentContext class in pi_agent/lib/src/types.dart"
Task: "Implement AgentLoopConfig class in pi_agent/lib/src/types.dart"

# Then sequentially (depends on types above):
Task: "Implement low-level agentLoop() function in pi_agent/lib/src/agent_loop.dart"
Task: "Implement Agent class in pi_agent/lib/src/agent.dart"
```

---

## Parallel Example: Post-Foundational

```bash
# These can ALL start after Phase 2 completes:
Task: "US5 LLM client implementation" (Phase 3)
Task: "US3 Skills loading" (Phase 6)
Task: "US4 Session storage" (Phase 7)
Task: "US7 Execution env" (Phase 9)

# US1 waits for US5; US2 waits for US1; US6 waits for US4; US3.5 waits for US3
```

---

## Implementation Strategy

### MVP First (US5 + US1 + US2)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational
3. Complete Phase 3: US5 (LLM Providers)
4. Complete Phase 4: US1 (Agent conversation)
5. Complete Phase 5: US2 (Tools)
6. **STOP and VALIDATE**: Agent can prompt, stream responses, execute tools, handle abort
7. Publish to pub.dev as 0.1.0

### Incremental Delivery

1. Setup + Foundational + US5 + US1 → Basic agent (v0.1.0)
2. Add US2 → Tools support (v0.2.0)
3. Add US3 + US3.5 → Skills + templates (v0.3.0)
4. Add US4 → Session persistence (v0.4.0)
5. Add US6 → Compaction (v0.5.0)
6. Add US7 → Execution env (v0.6.0)
7. Polish → Final pub.dev release (v1.0.0)

### Independent Story Validation

Each phase has a **Checkpoint** confirming the story can be tested independently:
- US5: `dart run pi_agent/example/llm_stream.dart` — streams raw LLM responses
- US1: Create Agent, prompt, verify events
- US2: Agent with tools executes tool calls
- US3: Load skills from directory, verify XML output
- US4: Create session, append, rebuild context
- US6: Build long context, trigger compaction
- US7: Run shell command, read file

---

## Notes

- [P] tasks = different files or independent sections, no dependencies on incomplete tasks
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- US5 is implemented before US1 due to technical dependency (Agent requires LLM client)
- Verify tests fail before implementing (red-green-refactor)
- Commit after each checkpoint
- Stop at any checkpoint to validate story independently
- Avoid: vague tasks, same file conflicts, cross-story dependencies that break independence
