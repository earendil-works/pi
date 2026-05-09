# Data Model: Dart Agent Package

## Entity Definitions

### AgentEvent (Sealed Union)

Discriminated union of all events emitted during agent execution. Pattern-matched exhaustively by subscribers.

```
sealed class AgentEvent {
  const AgentEvent();
}

class AgentStart extends AgentEvent {
  final String? sessionId;
  const AgentStart({this.sessionId});
}

class AgentEnd extends AgentEvent {
  final List<AgentMessage> messages;
  const AgentEnd({required this.messages});
}

class TurnStart extends AgentEvent {
  const TurnStart();
}

class TurnEnd extends AgentEvent {
  final AgentMessage message;
  final List<ToolResultMessage> toolResults;
  const TurnEnd({required this.message, required this.toolResults});
}

class MessageStart extends AgentEvent {
  final AgentMessage message;
  const MessageStart({required this.message});
}

class MessageUpdate extends AgentEvent {
  final AgentMessage message;
  const MessageUpdate({required this.message});
}

class MessageEnd extends AgentEvent {
  final AgentMessage message;
  const MessageEnd({required this.message});
}

class ToolExecutionStart extends AgentEvent {
  final String toolCallId;
  final String toolName;
  final Map<String, dynamic> args;
  const ToolExecutionStart({required this.toolCallId, required this.toolName, required this.args});
}

class ToolExecutionUpdate extends AgentEvent {
  final String toolCallId;
  final String toolName;
  final Map<String, dynamic> args;
  final dynamic partialResult;
  const ToolExecutionUpdate({required this.toolCallId, required this.toolName, required this.args, required this.partialResult});
}

class ToolExecutionEnd extends AgentEvent {
  final String toolCallId;
  final String toolName;
  final Map<String, dynamic> args;
  final dynamic result;
  final bool isError;
  const ToolExecutionEnd({required this.toolCallId, required this.toolName, required this.args, required this.result, required this.isError});
}
```

---

### AgentState

Immutable snapshot of agent context at any point in time. Accessible read-only via `Agent.state`.

```dart
class AgentState {
  final String systemPrompt;
  final Model model;
  final ThinkingLevel thinkingLevel;
  final List<AgentTool> _tools;
  final List<AgentMessage> _messages;
  final bool isStreaming;
  final AgentMessage? streamingMessage;
  final Set<String> pendingToolCalls;
  final String? errorMessage;

  List<AgentTool> get tools => List.unmodifiable(_tools);
  List<AgentMessage> get messages => List.unmodifiable(_messages);
}
```

---

### AgentTool

Tool definition with typed parameter schema, execution function, and optional hooks.

```dart
class AgentTool<TParameters, TDetails> {
  final String name;
  final String description;
  final Map<String, dynamic> parameters; // JSON Schema
  final String label;

  /// Pre-normalize arguments before validation
  final Map<String, dynamic>? Function(Map<String, dynamic> args)? prepareArguments;

  /// Execute the tool and return result content + details
  final Future<AgentToolResult<TDetails>> Function(
    String toolCallId,
    Map<String, dynamic> params, {
    required Future<void> Function(TDetails update)? onUpdate,
    required void Function() isAborted,
  }) execute;

  final ToolExecutionMode executionMode; // sequential | parallel
}
```

---

### AgentToolResult

```dart
class AgentToolResult<T> {
  final List<ContentBlock> content;
  final T details;
  final bool terminate; // hint to skip follow-up LLM call

  const AgentToolResult({
    required this.content,
    required this.details,
    this.terminate = false,
  });
}
```

---

### ContentBlock (Sealed Union)

```dart
sealed class ContentBlock {
  const ContentBlock();
}

class TextBlock extends ContentBlock {
  final String text;
  const TextBlock(this.text);
}

class ImageBlock extends ContentBlock {
  final String base64Data;
  final String mediaType;
  const ImageBlock({required this.base64Data, required this.mediaType});
}
```

---

### AgentMessage (Sealed Union)

```dart
sealed class AgentMessage {
  const AgentMessage();
}

class UserMessage extends AgentMessage {
  final List<ContentBlock> content;
  const UserMessage({required this.content});
}

class AssistantMessage extends AgentMessage {
  final String? id;
  final List<dynamic> content; // mixed TextBlock, ToolCallBlock, ThinkingBlock
  final StopReason? stopReason;
  final Usage? usage;
  const AssistantMessage({this.id, required this.content, this.stopReason, this.usage});
}

class ToolResultMessage extends AgentMessage {
  final String toolCallId;
  final String toolName;
  final List<ContentBlock> content;
  final bool isError;
  const ToolResultMessage({
    required this.toolCallId,
    required this.toolName,
    required this.content,
    this.isError = false,
  });

```

---

### AgentLoopConfig

Configuration for the low-level agent loop.

```dart
class AgentLoopConfig {
  final Model model;
  final int? maxTokens;
  final double? temperature;
  final double? topP;
  final ToolExecutionMode toolExecution;
  final Future<List<Message>> Function(List<AgentMessage>) convertToLlm;
  final Future<List<AgentMessage>> Function(List<AgentMessage>, {void Function()? isAborted})? transformContext;
  final Future<String?> Function(String provider)? getApiKey;
  final bool Function(ShouldStopAfterTurnContext)? shouldStopAfterTurn;
  final Future<List<AgentMessage>> Function()? getSteeringMessages;
  final Future<List<AgentMessage>> Function()? getFollowUpMessages;
  final Future<BeforeToolCallResult?> Function(BeforeToolCallContext, {void Function()? isAborted})? beforeToolCall;
  final Future<AfterToolCallResult?> Function(AfterToolCallContext, {void Function()? isAborted})? afterToolCall;
}
```

---

### Session

Tree-of-entries persistent conversation storage.

```dart
class Session {
  final SessionStorage _storage;
  String? _leafId;

  Future<String> appendMessage(AgentMessage message);
  Future<String> appendThinkingLevelChange(ThinkingLevel level);
  Future<String> appendModelChange(String provider, String modelId);
  Future<String> appendCompaction(String summary, String firstKeptEntryId, int tokensBefore, {Map<String, dynamic>? details, bool fromHook = false});
  Future<String> appendLabel(String targetId, {String? label});
  Future<SessionContext> buildContext();
  Future<List<SessionTreeEntry>> getBranch({String? fromId});
  Future<String?> moveTo(String? entryId, {String? summary});
  Future<List<SessionTreeEntry>> getEntries();
  Future<SessionTreeEntry?> getEntry(String id);
  String? get leafId => _leafId;
  Future<SessionInfo> getMetadata();
}
```

---

### SessionTreeEntry (Sealed Union)

```dart
sealed class SessionTreeEntry {
  final String id;
  final String parentId;
  final DateTime timestamp;
  const SessionTreeEntry({required this.id, required this.parentId, required this.timestamp});
}

class MessageEntry extends SessionTreeEntry {
  final String role; // user, assistant, toolResult
  final AgentMessage message;
}

class ThinkingLevelChangeEntry extends SessionTreeEntry {
  final ThinkingLevel level;
}

class ModelChangeEntry extends SessionTreeEntry {
  final String provider;
  final String modelId;
}

class CompactionEntry extends SessionTreeEntry {
  final String summary;
  final String firstKeptEntryId;
  final int tokensBefore;
}

class LabelEntry extends SessionTreeEntry {
  final String targetId;
  final String? label;
}

class CustomEntry extends SessionTreeEntry {
  final String customType;
  final Map<String, dynamic>? data;
}
```

---

### SessionStorage (Interface)

```dart
abstract class SessionStorage {
  Future<void> init();
  Future<void> appendEntry(SessionTreeEntry entry);
  Future<List<SessionTreeEntry>> loadEntries();
  Future<SessionTreeEntry?> findEntry(String id);
  Future<List<SessionTreeEntry>> findEntries(String Function(SessionTreeEntry) predicate);
  Future<void> setLeafId(String? leafId);
  Future<String?> getLeafId();
  Future<void> setMetadata(SessionInfo info);
  Future<SessionInfo> getMetadata();
  Future<void> close();
}
```

---

### SessionInfo

```dart
class SessionInfo {
  final String id;
  final String name;
  final DateTime createdAt;
  final DateTime updatedAt;
  final Map<String, dynamic> metadata;

  const SessionInfo({
    required this.id,
    required this.name,
    required this.createdAt,
    required this.updatedAt,
    this.metadata = const {},
  });
}
```

---

### Skill

```dart
class Skill {
  final String name;
  final String description;
  final String content;       // full SKILL.md body
  final String? invocation;   // invocation format
  final bool hidden;          // hidden from available_skills block
  final String sourcePath;    // file path provenance
  final List<SkillDiagnostic> diagnostics;

  const Skill({
    required this.name,
    required this.description,
    required this.content,
    this.invocation,
    this.hidden = false,
    required this.sourcePath,
    this.diagnostics = const [],
  });
}
```

---

### PromptTemplate

```dart
class PromptTemplate {
  final String name;
  final String description;
  final String content;       // full template with $1, $@ placeholders
  final List<String> args;
  final String sourcePath;

  const PromptTemplate({
    required this.name,
    required this.description,
    required this.content,
    this.args = const [],
    required this.sourcePath,
  });
}
```

---

### ExecutionEnv (Interface)

```dart
abstract class ExecutionEnv {
  Future<String> readFile(String path);
  Future<void> writeFile(String path, String content);
  Future<List<String>> listDirectory(String path);
  Future<void> removeFile(String path);
  Future<FileInfo> fileInfo(String path);
  Future<bool> fileExists(String path);
  Future<ShellResult> exec(String command, {String? workingDirectory, Map<String, String>? environment, void Function()? isAborted});
  Future<String> createTempFile({String? prefix, String? suffix});
  Future<String> createTempDirectory({String? prefix});
}
```

---

### Model

```dart
class Model {
  final String provider;
  final String modelId;
  final int contextWindow;
  final bool supportsVision;
  final bool supportsThinking;
  final bool supportsTools;
  final Map<String, dynamic>? extra;

  const Model({
    required this.provider,
    required this.modelId,
    required this.contextWindow,
    this.supportsVision = false,
    this.supportsThinking = false,
    this.supportsTools = true,
    this.extra,
  });
}
```

---

### Enums

```dart
enum ThinkingLevel { off, minimal, low, medium, high, xhigh }

enum ToolExecutionMode { sequential, parallel }

enum StopReason { endTurn, maxTokens, toolUse, stopSequence, refused }

enum FileErrorCode { notFound, notDirectory, permissionDenied, ioError }
```

---

### Entity Relationships

```
Agent
  ├── owns AgentState (1:1)
  │     ├── contains Model (1:1)
  │     ├── contains List<AgentTool> (1:N)
  │     └── contains List<AgentMessage> (1:N)
  ├── emits AgentEvent (1:N stream)
  ├── uses AgentLoopConfig (1:1 per run)
  └── delegates to agentLoop() function

Session (optional, can be null)
  ├── owns SessionStorage (1:1)
  ├── contains List<SessionTreeEntry> (1:N)
  │     └── SessionTreeEntry.parentId → self-referential tree
  └── produces SessionContext via buildContext()

Skill → loaded from SKILL.md file (N:1 per file)
PromptTemplate → loaded from .md file (N:1 per file)
ExecutionEnv → used by Agent for tool execution (1:1, optional)
```

### State Transitions

**Agent Run States:**
```
IDLE → (prompt/continue) → RUNNING → (turn complete) → IDLE
RUNNING → (abort) → ERROR → (waitForIdle) → IDLE
RUNNING → (tool execution) → EXECUTING_TOOLS → (tools done) → RUNNING
```

**Session Leaf States:**
```
ROOT_ENTRY → appendMessage → LEAF_CHILD → appendMessage → NEW_LEAF
ANY_NODE → moveTo(targetId) → NEW_LEAF (branching)
```
