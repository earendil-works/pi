# Public API Contract: pi_agent

## Package Name

`pi_agent`

## Top-Level Library

`package:pi/pi.dart` — Barrel export of all public API members.

---

## Exports by Module

### agent.dart

Core Agent class and configuration.

```dart
// Constructor
Agent({
  Model? model,
  String? systemPrompt,
  ThinkingLevel? thinkingLevel,
  List<AgentTool>? tools,
  List<AgentMessage>? messages,
  String? sessionId,
  StreamFn? streamFn,
  MessageConverter? convertToLlm,
  ContextTransformer? transformContext,
  ApiKeyResolver? getApiKey,
  BeforeToolCallHook? beforeToolCall,
  AfterToolCallHook? afterToolCall,
  ToolExecutionMode? toolExecution,
  SteeringMode? steeringMode,
  FollowUpMode? followUpMode,
  Map<ThinkingLevel, int>? thinkingBudgets,
});

// Core methods
Future<void> prompt(dynamic input);  // String | List<ContentBlock> | AgentMessage | List<AgentMessage>
Future<void> continue_();           // Dart keyword workaround: continue_()
void steer(AgentMessage message);
void followUp(AgentMessage message);
void abort();
Future<void> waitForIdle();
void reset();
void Function() subscribe(void Function(AgentEvent) listener, {void Function()? onCancel});

// Properties
AgentState get state;
bool get isRunning;

// Setters for configuration that can change at runtime
set convertToLlm(MessageConverter? fn);
set transformContext(ContextTransformer? fn);
set streamFn(StreamFn? fn);
set getApiKey(ApiKeyResolver? fn);
set beforeToolCall(BeforeToolCallHook? fn);
set afterToolCall(AfterToolCallHook? fn);
set sessionId(String? id);
set toolExecution(ToolExecutionMode mode);
set steeringMode(SteeringMode mode);
set followUpMode(FollowUpMode mode);
```

### types.dart

Core data types used throughout the package.

```dart
// Message sealed union
sealed class AgentMessage { ... }
class UserMessage extends AgentMessage { List<ContentBlock> content; }
class AssistantMessage extends AgentMessage { String? id; List<dynamic> content; StopReason? stopReason; Usage? usage; }
class ToolResultMessage extends AgentMessage { String toolCallId; String toolName; List<ContentBlock> content; bool isError; }
class CustomMessage extends AgentMessage { String type; Map<String, dynamic> data; }

// Content blocks
sealed class ContentBlock { ... }
class TextBlock extends ContentBlock { String text; }
class ImageBlock extends ContentBlock { String base64Data; String mediaType; }

// Event discriminated union
sealed class AgentEvent { ... }
class AgentStart extends AgentEvent { String? sessionId; }
class AgentEnd extends AgentEvent { List<AgentMessage> messages; }
class TurnStart extends AgentEvent {}
class TurnEnd extends AgentEvent { AgentMessage message; List<ToolResultMessage> toolResults; }
class MessageStart extends AgentEvent { AgentMessage message; }
class MessageUpdate extends AgentEvent { AgentMessage message; }
class MessageEnd extends AgentEvent { AgentMessage message; }
class ToolExecutionStart extends AgentEvent { String toolCallId; String toolName; Map<String, dynamic> args; }
class ToolExecutionUpdate extends AgentEvent { String toolCallId; String toolName; Map<String, dynamic> args; dynamic partialResult; }
class ToolExecutionEnd extends AgentEvent { String toolCallId; String toolName; Map<String, dynamic> args; dynamic result; bool isError; }

// Agent state
class AgentState {
  String systemPrompt;
  Model model;
  ThinkingLevel thinkingLevel;
  List<AgentTool> get tools;
  List<AgentMessage> get messages;
  bool isStreaming;
  AgentMessage? streamingMessage;
  Set<String> pendingToolCalls;
  String? errorMessage;
}

// Model definition
class Model {
  String provider;
  String modelId;
  int contextWindow;
  bool supportsVision;
  bool supportsThinking;
  bool supportsTools;
  Map<String, dynamic>? extra;
}

// Usage tracking
class Usage { int inputTokens; int outputTokens; int? cacheCreationInputTokens; int? cacheReadInputTokens; }

// Hook context types
class BeforeToolCallContext { String toolCallId; String toolName; Map<String, dynamic> args; void Function(Map<String, dynamic> newArgs) overrideArgs; }
class AfterToolCallContext { String toolCallId; String toolName; Map<String, dynamic> args; AgentToolResult result; }
class ShouldStopAfterTurnContext { AgentMessage lastMessage; List<ToolResultMessage> toolResults; int turnCount; }

// Hook result types
class BeforeToolCallResult { dynamic block; String? reason; }
class AfterToolCallResult { List<ContentBlock>? content; dynamic details; bool? isError; bool? terminate; }

// Tool result
class AgentToolResult<T> { List<ContentBlock> content; T details; bool terminate; }

// Configuration
class AgentLoopConfig {
  Model model;
  int? maxTokens; double? temperature; double? topP;
  ToolExecutionMode toolExecution;
  MessageConverter convertToLlm;
  ContextTransformer? transformContext;
  ApiKeyResolver? getApiKey;
  StopCondition? shouldStopAfterTurn;
  MessageProvider? getSteeringMessages;
  MessageProvider? getFollowUpMessages;
  BeforeToolCallHook? beforeToolCall;
  AfterToolCallHook? afterToolCall;
}

// Enums
enum ThinkingLevel { off, minimal, low, medium, high, xhigh }
enum ToolExecutionMode { sequential, parallel }
enum StopReason { endTurn, maxTokens, toolUse, stopSequence, refused }
enum SteeringMode { all, oneAtATime }
enum FollowUpMode { all, oneAtATime }
```

### agent_loop.dart

Low-level agent loop functions. Used by Agent internally but exposed for advanced use.

```dart
import 'dart:async';

Stream<AgentEvent> agentLoop(AgentContext context, AgentLoopConfig config);
Stream<AgentEvent> agentLoopContinue(AgentContext context, AgentLoopConfig config);

// Simplified async wrappers
Future<List<AgentMessage>> runAgentLoop(AgentContext context, AgentLoopConfig config);
Future<List<AgentMessage>> runAgentLoopContinue(AgentContext context, AgentLoopConfig config);
```

### tools.dart

Tool definition and validation.

```dart
class AgentTool<T, D> {
  final String name;
  final String description;
  final Map<String, dynamic> parameters;
  final String label;
  final Map<String, dynamic>? Function(Map<String, dynamic>)? prepareArguments;
  final ToolExecutionMode? executionMode;

  AgentTool({
    required this.name,
    required this.description,
    required this.parameters,
    this.label = '',
    Future<AgentToolResult<D>> Function(String toolCallId, Map<String, dynamic> params, {void Function(D)? onUpdate, void Function()? isAborted})? execute,
    this.prepareArguments,
    this.executionMode,
  });

  Future<AgentToolResult<D>> execute(String toolCallId, Map<String, dynamic> params, {void Function(D)? onUpdate, void Function()? isAborted});
}

List<String>? validateParameters(Map<String, dynamic> schema, Map<String, dynamic> values);
```

### session.dart

Session management for persistent conversations.

```dart
class Session {
  final String id;
  Session(SessionStorage storage);

  Future<String> appendMessage(AgentMessage message);
  Future<String> appendThinkingLevelChange(ThinkingLevel level);
  Future<String> appendModelChange(String provider, String modelId);
  Future<String> appendCompaction(String summary, String firstKeptEntryId, int tokensBefore, {Map<String, dynamic>? details, bool fromHook = false});
  Future<String> appendLabel(String targetId, {String? label});
  Future<String> appendCustomEntry(String type, {Map<String, dynamic>? data});

  Future<SessionContext> buildContext();
  Future<List<SessionTreeEntry>> getBranch({String? fromId});
  Future<String?> moveTo(String? entryId, {String? summary});
  Future<List<SessionTreeEntry>> getEntries();
  Future<SessionTreeEntry?> getEntry(String id);
  String? get leafId;
  Future<SessionInfo> getMetadata();
}

class SessionContext {
  List<AgentMessage> messages;
  ThinkingLevel thinkingLevel;
  Model model;
}

abstract class SessionStorage {
  Future<void> init();
  Future<void> appendEntry(SessionTreeEntry entry);
  Future<List<SessionTreeEntry>> loadEntries();
  Future<SessionTreeEntry?> findEntry(String id);
  Future<void> setLeafId(String? leafId);
  Future<String?> getLeafId();
  Future<void> setMetadata(SessionInfo info);
  Future<SessionInfo> getMetadata();
  Future<void> close();
}
```

### session_storage.dart

Concrete storage implementations.

```dart
class InMemorySessionStorage implements SessionStorage { ... }
class JsonlSessionStorage implements SessionStorage {
  JsonlSessionStorage(String filePath);
}
```

### skills.dart

SKILL.md loading and formatting.

```dart
class Skill {
  String name;
  String description;
  String content;
  String? invocation;
  bool hidden;
  String sourcePath;
  List<SkillDiagnostic> diagnostics;

  Skill({required String name, required String description, required String content, String? invocation, bool hidden = false, required String sourcePath, List<SkillDiagnostic> diagnostics = const []});
}

class SkillDiagnostic {
  SkillDiagnosticLevel level;
  String message;
  String? sourcePath;

  SkillDiagnostic({required this.level, required this.message, this.sourcePath});
}

enum SkillDiagnosticLevel { warning, error }

Future<List<Skill>> loadSkills(List<String> directories, {bool followSymlinks = true});
Future<List<Skill>> loadSourcedSkills<TSource>(List<({TSource source, String directory})> sourceDirs, {bool followSymlinks = true});

String formatSkillInvocation(Skill skill);
String formatSkillsForSystemPrompt(List<Skill> skills);
```

### prompt_templates.dart

Prompt template loading and argument substitution.

```dart
class PromptTemplate {
  String name;
  String description;
  String content;
  List<String> args;
  String sourcePath;

  PromptTemplate({required String name, required String description, required String content, List<String> args = const [], required String sourcePath});
}

class PromptTemplateDiagnostic {
  PromptTemplateDiagnosticLevel level;
  String message;
  String? sourcePath;
}

enum PromptTemplateDiagnosticLevel { warning, error }

Future<List<PromptTemplate>> loadPromptTemplates(List<String> paths);
Future<List<PromptTemplate>> loadSourcedPromptTemplates<TSource>(List<({TSource source, String path})> sourcePaths);

String formatPromptTemplateInvocation(PromptTemplate template, {List<String>? args, String? arguments});
```

### execution_env.dart

Filesystem and shell abstraction.

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

class FileInfo {
  String path;
  FileKind kind;
  int size;
  DateTime modified;
}

enum FileKind { file, directory, symlink }

class ShellResult {
  String stdout;
  String stderr;
  int exitCode;
}

class FileError implements Exception {
  String path;
  FileErrorCode code;
  String message;

  FileError({required this.path, required this.code, required this.message});
}

enum FileErrorCode { notFound, notDirectory, permissionDenied, ioError }

class NodeExecutionEnv implements ExecutionEnv { ... }
```

### compaction.dart

Context compaction utilities.

```dart
class CompactionSettings {
  bool enabled;
  int reserveTokens;
  int keepRecentTokens;

  CompactionSettings({this.enabled = true, this.reserveTokens = 16384, this.keepRecentTokens = 20000});
}

Future<int> calculateContextTokens(Usage usage);
Future<int> estimateContextTokens(List<AgentMessage> messages);
bool shouldCompact(List<AgentMessage> messages, int contextWindow, {CompactionSettings settings});
int? findCutPoint(List<SessionTreeEntry> entries, int keepTokens, {int startIndex = 0});
Future<String> generateSummary(List<AgentMessage> messages, Model model, {String? apiKey, String? customInstructions});
Future<CompactionPreparation> prepareCompaction(List<SessionTreeEntry> entries, int keepTokens);
Future<CompactionResult> compact(List<SessionTreeEntry> entries, Model model, {String? apiKey, CompactionSettings? settings, String? customInstructions, String? previousSummary});

class CompactionPreparation {
  int cutIndex;
  int tokensCut;
  List<SessionTreeEntry> keptEntries;
  List<SessionTreeEntry> cutEntries;
  String? previousSummary;
  List<FileOperation> fileOps;
}

class CompactionResult {
  String summary;
  String firstKeptEntryId;
  int tokensBefore;
  CompactionPreparation preparation;
  List<FileOperation> fileOps;
}
```

### constants.dart

```dart
const defaultCompactionSettings = CompactionSettings();
```

---

## Callback Type Aliases

```dart
typedef MessageConverter = Future<List<Message>> Function(List<AgentMessage> messages);
typedef ContextTransformer = Future<List<AgentMessage>> Function(List<AgentMessage> messages, {void Function()? isAborted});
typedef ApiKeyResolver = Future<String?> Function(String provider);
typedef StopCondition = bool Function(ShouldStopAfterTurnContext context);
typedef MessageProvider = Future<List<AgentMessage>> Function();
typedef BeforeToolCallHook = Future<BeforeToolCallResult?> Function(BeforeToolCallContext context, {void Function()? isAborted});
typedef AfterToolCallHook = Future<AfterToolCallResult?> Function(AfterToolCallContext context, {void Function()? isAborted});
typedef StreamFn = Stream<Map<String, dynamic>> Function(Map<String, dynamic> request, {void Function()? isAborted});
```

---

## Import Path

```dart
import 'package:pi/pi.dart';
```
