/// Core types for the pi_agent package.
///
/// Defines all sealed class hierarchies, enums, and configuration types
/// used throughout the agent framework.
library;

/// Thinking/reasoning level for models that support extended thinking.
enum ThinkingLevel {
  /// No thinking output.
  off,

  /// Minimal thinking.
  minimal,

  /// Low thinking effort.
  low,

  /// Medium thinking effort.
  medium,

  /// High thinking effort.
  high,

  /// Extra-high thinking effort.
  xhigh,
}

/// Tool execution concurrency mode.
enum ToolExecutionMode {
  /// Execute tool calls sequentially, one at a time.
  sequential,

  /// Execute tool calls in parallel using Future.wait.
  parallel,
}

/// Reason the LLM stopped generating.
enum StopReason {
  /// The model finished its response naturally.
  endTurn,

  /// The model hit the maximum token limit.
  maxTokens,

  /// The model requested a tool call.
  toolUse,

  /// The model hit a stop sequence.
  stopSequence,

  /// The model refused to respond.
  refused,
}

/// Steering message dispatch mode.
enum SteeringMode {
  /// Inject all queued steering messages at once.
  all,

  /// Inject one steering message at a time.
  oneAtATime,
}

/// Follow-up message dispatch mode.
enum FollowUpMode {
  /// Inject all queued follow-up messages at once.
  all,

  /// Inject one follow-up message at a time.
  oneAtATime,
}

/// LLM model descriptor.
///
/// Describes a specific model including its provider, identifier,
/// context window size, and capability flags.
class Model {
  /// Provider name (e.g., 'openai', 'anthropic').
  final String provider;

  /// Model identifier (e.g., 'gpt-4o', 'claude-sonnet-4-20250514').
  final String modelId;

  /// Maximum context window in tokens.
  final int contextWindow;

  /// Whether the model supports image inputs.
  final bool supportsVision;

  /// Whether the model supports extended thinking.
  final bool supportsThinking;

  /// Whether the model supports tool/function calling.
  final bool supportsTools;

  /// Additional provider-specific configuration.
  final Map<String, dynamic>? extra;

  /// Creates a model descriptor.
  const Model({
    required this.provider,
    required this.modelId,
    required this.contextWindow,
    this.supportsVision = false,
    this.supportsThinking = false,
    this.supportsTools = true,
    this.extra,
  });

  @override
  String toString() => 'Model($provider/$modelId)';
}

/// Token usage tracking from an LLM response.
class Usage {
  /// Number of input tokens consumed.
  final int inputTokens;

  /// Number of output tokens generated.
  final int outputTokens;

  /// Tokens used for cache creation (provider-specific).
  final int? cacheCreationInputTokens;

  /// Tokens read from cache (provider-specific).
  final int? cacheReadInputTokens;

  /// Creates a usage record.
  const Usage({
    required this.inputTokens,
    required this.outputTokens,
    this.cacheCreationInputTokens,
    this.cacheReadInputTokens,
  });
}

/// A content block within a message.
///
/// Sealed union of text and image content types.
sealed class ContentBlock {
  /// Creates a content block.
  const ContentBlock();
}

/// A text content block.
class TextBlock extends ContentBlock {
  /// The text content.
  final String text;

  /// Creates a text block.
  const TextBlock(this.text);

  @override
  String toString() => 'TextBlock($text)';
}

/// An image content block encoded as base64.
class ImageBlock extends ContentBlock {
  /// Base64-encoded image data.
  final String base64Data;

  /// MIME type of the image (e.g., 'image/png').
  final String mediaType;

  /// Creates an image block.
  const ImageBlock({required this.base64Data, required this.mediaType});
}

/// A tool call within an assistant message's content.
class ToolCallBlock {
  /// Unique identifier for this tool call.
  final String id;

  /// Name of the tool to invoke.
  final String name;

  /// Arguments for the tool call as a JSON-compatible map.
  final Map<String, dynamic> arguments;

  /// Creates a tool call block.
  const ToolCallBlock({
    required this.id,
    required this.name,
    required this.arguments,
  });
}

/// A thinking/reasoning content block.
class ThinkingBlock {
  /// The thinking text content.
  final String text;

  /// Creates a thinking block.
  const ThinkingBlock(this.text);
}

/// Agent message discriminated union.
///
/// Sealed hierarchy representing all message types in an agent conversation.
sealed class AgentMessage {
  /// Creates an agent message.
  const AgentMessage();
}

/// A message from the user.
class UserMessage extends AgentMessage {
  /// Content blocks in this message.
  final List<ContentBlock> content;

  /// Creates a user message.
  const UserMessage({required this.content});

  /// Convenience constructor from a plain text string.
  UserMessage.text(String text) : content = [TextBlock(text)];
}

/// A message from the assistant (LLM).
class AssistantMessage extends AgentMessage {
  /// Optional message ID from the provider.
  final String? id;

  /// Content blocks (mixed TextBlock, ToolCallBlock, ThinkingBlock).
  final List<dynamic> content;

  /// Reason the assistant stopped generating.
  final StopReason? stopReason;

  /// Token usage for this response.
  final Usage? usage;

  /// Creates an assistant message.
  const AssistantMessage({
    this.id,
    required this.content,
    this.stopReason,
    this.usage,
  });

  /// Extracts all text content from this message.
  String get text => content.whereType<TextBlock>().map((b) => b.text).join();

  /// Extracts all tool call blocks.
  List<ToolCallBlock> get toolCalls =>
      content.whereType<ToolCallBlock>().toList();
}

/// A tool result message returned after tool execution.
class ToolResultMessage extends AgentMessage {
  /// ID of the tool call this result corresponds to.
  final String toolCallId;

  /// Name of the tool that was executed.
  final String toolName;

  /// Result content blocks.
  final List<ContentBlock> content;

  /// Whether the tool execution resulted in an error.
  final bool isError;

  /// Creates a tool result message.
  const ToolResultMessage({
    required this.toolCallId,
    required this.toolName,
    required this.content,
    this.isError = false,
  });

  /// Convenience constructor from a plain text string.
  ToolResultMessage.text({
    required this.toolCallId,
    required this.toolName,
    required String text,
    this.isError = false,
  }) : content = [TextBlock(text)];
}

/// A custom message type for application-specific data.
class CustomMessage extends AgentMessage {
  /// The custom message type identifier.
  final String type;

  /// Application-specific data payload.
  final Map<String, dynamic> data;

  /// Display text representation of this message.
  final String display;

  /// Creates a custom message.
  const CustomMessage({
    required this.type,
    required this.data,
    required this.display,
  });
}

/// Agent lifecycle event discriminated union.
///
/// All events emitted during agent execution. Use exhaustive pattern matching
/// via Dart's switch expressions on sealed classes.
sealed class AgentEvent {
  /// Creates an agent event.
  const AgentEvent();
}

/// Emitted when an agent run starts.
class AgentStart extends AgentEvent {
  /// Optional session identifier.
  final String? sessionId;

  /// Creates an agent start event.
  const AgentStart({this.sessionId});
}

/// Emitted when an agent run completes.
class AgentEnd extends AgentEvent {
  /// All messages produced during this run.
  final List<AgentMessage> messages;

  /// Creates an agent end event.
  const AgentEnd({required this.messages});
}

/// Emitted at the start of each turn (one LLM call + tool execution cycle).
class TurnStart extends AgentEvent {
  /// Creates a turn start event.
  const TurnStart();
}

/// Emitted at the end of each turn.
class TurnEnd extends AgentEvent {
  /// The assistant message produced this turn.
  final AgentMessage message;

  /// Tool results from tool execution this turn.
  final List<ToolResultMessage> toolResults;

  /// Creates a turn end event.
  const TurnEnd({required this.message, required this.toolResults});
}

/// Emitted when a message starts being streamed.
class MessageStart extends AgentEvent {
  /// The message being started.
  final AgentMessage message;

  /// Creates a message start event.
  const MessageStart({required this.message});
}

/// Emitted when a message is updated during streaming.
class MessageUpdate extends AgentEvent {
  /// The message with updated content.
  final AgentMessage message;

  /// Creates a message update event.
  const MessageUpdate({required this.message});
}

/// Emitted when a message finishes streaming.
class MessageEnd extends AgentEvent {
  /// The completed message.
  final AgentMessage message;

  /// Creates a message end event.
  const MessageEnd({required this.message});
}

/// Emitted when a tool starts executing.
class ToolExecutionStart extends AgentEvent {
  /// ID of the tool call.
  final String toolCallId;

  /// Name of the tool being executed.
  final String toolName;

  /// Arguments passed to the tool.
  final Map<String, dynamic> args;

  /// Creates a tool execution start event.
  const ToolExecutionStart({
    required this.toolCallId,
    required this.toolName,
    required this.args,
  });
}

/// Emitted when a tool reports a partial update during execution.
class ToolExecutionUpdate extends AgentEvent {
  /// ID of the tool call.
  final String toolCallId;

  /// Name of the tool.
  final String toolName;

  /// Arguments passed to the tool.
  final Map<String, dynamic> args;

  /// Partial result data from the tool.
  final dynamic partialResult;

  /// Creates a tool execution update event.
  const ToolExecutionUpdate({
    required this.toolCallId,
    required this.toolName,
    required this.args,
    required this.partialResult,
  });
}

/// Emitted when a tool finishes executing.
class ToolExecutionEnd extends AgentEvent {
  /// ID of the tool call.
  final String toolCallId;

  /// Name of the tool.
  final String toolName;

  /// Arguments that were passed to the tool.
  final Map<String, dynamic> args;

  /// The tool result.
  final dynamic result;

  /// Whether the tool execution resulted in an error.
  final bool isError;

  /// Creates a tool execution end event.
  const ToolExecutionEnd({
    required this.toolCallId,
    required this.toolName,
    required this.args,
    required this.result,
    required this.isError,
  });
}

/// Read-only snapshot of agent state.
///
/// Internal fields are accessible within the package for mutation
/// by the [Agent] class. External consumers see read-only views.
class AgentState {
  /// System prompt (mutable internally).
  String systemPrompt;

  /// Current model (immutable after creation).
  final Model model;

  /// Thinking level (mutable internally).
  ThinkingLevel thinkingLevel;

  /// Internal tool list (mutable internally).
  final List<AgentTool<dynamic, dynamic>> internalTools;

  /// Internal message list (mutable internally).
  final List<AgentMessage> internalMessages;

  /// Whether the agent is currently streaming.
  bool isStreaming;

  /// The message currently being streamed.
  AgentMessage? streamingMessage;

  /// Tool call IDs currently being executed.
  final Set<String> internalPendingToolCalls;

  /// Error message from the last failed run.
  String? errorMessage;

  /// Creates an agent state.
  AgentState({
    required this.systemPrompt,
    required this.model,
    this.thinkingLevel = ThinkingLevel.off,
    List<AgentTool<dynamic, dynamic>>? tools,
    List<AgentMessage>? messages,
    this.isStreaming = false,
    this.streamingMessage,
    Set<String>? pendingToolCalls,
    this.errorMessage,
  })  : internalTools = List.from(tools ?? []),
        internalMessages = List.from(messages ?? []),
        internalPendingToolCalls = pendingToolCalls ?? {};

  /// Current registered tools (unmodifiable view).
  List<AgentTool<dynamic, dynamic>> get tools =>
      List.unmodifiable(internalTools);

  set tools(List<AgentTool<dynamic, dynamic>> value) {
    internalTools
      ..clear()
      ..addAll(value);
  }

  /// Current conversation transcript (unmodifiable view).
  List<AgentMessage> get messages => List.unmodifiable(internalMessages);

  set messages(List<AgentMessage> value) {
    internalMessages
      ..clear()
      ..addAll(value);
  }

  /// Tool call IDs currently being executed (unmodifiable view).
  Set<String> get pendingToolCalls =>
      Set.unmodifiable(internalPendingToolCalls);
}

/// Context for beforeToolCall hooks.
class BeforeToolCallContext {
  /// ID of the tool call.
  final String toolCallId;

  /// Name of the tool being called.
  final String toolName;

  /// Arguments from the LLM.
  final Map<String, dynamic> args;

  final void Function(Map<String, dynamic> newArgs) _overrideArgs;

  /// Creates a before tool call context.
  BeforeToolCallContext({
    required this.toolCallId,
    required this.toolName,
    required this.args,
    required void Function(Map<String, dynamic> newArgs) overrideArgs,
  }) : _overrideArgs = overrideArgs;

  /// Replace the tool call arguments with new values.
  void overrideArgs(Map<String, dynamic> newArgs) => _overrideArgs(newArgs);
}

/// Context for afterToolCall hooks.
class AfterToolCallContext {
  /// ID of the tool call.
  final String toolCallId;

  /// Name of the tool that was called.
  final String toolName;

  /// Arguments that were passed.
  final Map<String, dynamic> args;

  /// The result from tool execution.
  final AgentToolResult<dynamic> result;

  /// Creates an after tool call context.
  const AfterToolCallContext({
    required this.toolCallId,
    required this.toolName,
    required this.args,
    required this.result,
  });
}

/// Context for shouldStopAfterTurn callback.
class ShouldStopAfterTurnContext {
  /// The last message in the turn.
  final AgentMessage lastMessage;

  /// Tool results from this turn.
  final List<ToolResultMessage> toolResults;

  /// Number of turns completed so far.
  final int turnCount;

  /// Creates a stop-after-turn context.
  const ShouldStopAfterTurnContext({
    required this.lastMessage,
    required this.toolResults,
    required this.turnCount,
  });
}

/// Result from a beforeToolCall hook.
class BeforeToolCallResult {
  /// Optional block content to return instead of executing the tool.
  final dynamic block;

  /// Reason for blocking the tool call.
  final String? reason;

  /// Creates a before tool call result.
  const BeforeToolCallResult({this.block, this.reason});
}

/// Result from an afterToolCall hook.
class AfterToolCallResult {
  /// Override content to send back to the LLM.
  final List<ContentBlock>? content;

  /// Structured details for UI/logs.
  final dynamic details;

  /// Whether the tool result should be treated as an error.
  final bool? isError;

  /// Hint to skip the follow-up LLM call.
  final bool? terminate;

  /// Creates an after tool call result.
  const AfterToolCallResult(
      {this.content, this.details, this.isError, this.terminate});
}

/// Result from tool execution.
class AgentToolResult<T> {
  /// Content blocks to send back to the LLM.
  final List<ContentBlock> content;

  /// Structured details for UI/logging.
  final T details;

  /// Hint to skip the follow-up LLM call after this batch.
  final bool terminate;

  /// Creates a tool result.
  const AgentToolResult({
    required this.content,
    required this.details,
    this.terminate = false,
  });
}

/// Snapshot of context sent to the LLM.
class AgentContext {
  /// The system prompt.
  final String systemPrompt;

  /// Formatted messages for the LLM.
  final List<AgentMessage> messages;

  /// Active tools available to the LLM.
  final List<AgentTool<dynamic, dynamic>>? tools;

  /// Creates an agent context.
  const AgentContext({
    required this.systemPrompt,
    required this.messages,
    this.tools,
  });
}

/// Configuration for the low-level agent loop.
class AgentLoopConfig {
  /// The model to use for LLM calls.
  final Model model;

  /// Maximum tokens to generate.
  final int? maxTokens;

  /// Sampling temperature.
  final double? temperature;

  /// Top-p (nucleus) sampling parameter.
  final double? topP;

  /// Tool execution concurrency mode.
  final ToolExecutionMode toolExecution;

  /// Converts agent messages to LLM-compatible format.
  final Future<List<Map<String, dynamic>>> Function(List<AgentMessage>)
      convertToLlm;

  /// Optional context transformation before each LLM call.
  final Future<List<AgentMessage>> Function(List<AgentMessage>,
      {bool Function()? isAborted})? transformContext;

  /// Resolves API keys for providers.
  final Future<String?> Function(String provider)? getApiKey;

  /// Callback to check if the loop should stop after a turn.
  final bool Function(ShouldStopAfterTurnContext)? shouldStopAfterTurn;

  /// Provides steering messages injected mid-turn.
  final Future<List<AgentMessage>> Function()? getSteeringMessages;

  /// Provides follow-up messages injected after a turn.
  final Future<List<AgentMessage>> Function()? getFollowUpMessages;

  /// Hook called before each tool execution.
  final Future<BeforeToolCallResult?> Function(BeforeToolCallContext,
      {bool Function()? isAborted})? beforeToolCall;

  /// Hook called after each tool execution.
  final Future<AfterToolCallResult?> Function(AfterToolCallContext,
      {bool Function()? isAborted})? afterToolCall;

  /// Extra headers to send with each LLM request.
  final Map<String, String>? extraHeaders;

  /// Creates agent loop configuration.
  const AgentLoopConfig({
    required this.model,
    this.maxTokens,
    this.temperature,
    this.topP,
    this.toolExecution = ToolExecutionMode.parallel,
    required this.convertToLlm,
    this.transformContext,
    this.getApiKey,
    this.shouldStopAfterTurn,
    this.getSteeringMessages,
    this.getFollowUpMessages,
    this.beforeToolCall,
    this.afterToolCall,
    this.extraHeaders,
  });
}

/// A tool definition for the agent.
///
/// Full implementation is in `tools.dart`.
///
/// This typedef provides a forward reference to the tool type
/// used in [AgentState] and [AgentContext]. The concrete class
/// [AgentToolImpl] is defined in `tools.dart`.
typedef AgentTool<TParameters, TDetails> = dynamic;

/// Skill loaded from a SKILL.md file.
class Skill {
  /// Skill name from YAML frontmatter.
  final String name;

  /// Skill description.
  final String description;

  /// Full SKILL.md body content.
  final String content;

  /// Invocation format string.
  final String? invocation;

  /// Whether this skill is hidden from the system prompt.
  final bool hidden;

  /// File path this skill was loaded from.
  final String sourcePath;

  /// Diagnostics from loading.
  final List<SkillDiagnostic> diagnostics;

  /// Creates a skill.
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

/// Diagnostic from skill loading.
class SkillDiagnostic {
  /// Severity level.
  final SkillDiagnosticLevel level;

  /// Diagnostic message.
  final String message;

  /// File path that triggered this diagnostic.
  final String? sourcePath;

  /// Creates a skill diagnostic.
  const SkillDiagnostic({
    required this.level,
    required this.message,
    this.sourcePath,
  });
}

/// Skill diagnostic severity level.
enum SkillDiagnosticLevel {
  /// Warning - skill loaded but with issues.
  warning,

  /// Error - skill could not be loaded.
  error,
}

/// Prompt template loaded from a .md file.
class PromptTemplate {
  /// Template name.
  final String name;

  /// Template description.
  final String description;

  /// Full template content with placeholders.
  final String content;

  /// Named arguments expected by this template.
  final List<String> args;

  /// File path this template was loaded from.
  final String sourcePath;

  /// Creates a prompt template.
  const PromptTemplate({
    required this.name,
    required this.description,
    required this.content,
    this.args = const [],
    required this.sourcePath,
  });
}

/// Session tree entry discriminated union.
///
/// Each entry is a node in the session tree with an ID and parent reference.
sealed class SessionTreeEntry {
  /// Unique entry identifier.
  final String id;

  /// Parent entry ID (empty string for root).
  final String parentId;

  /// When this entry was created.
  final DateTime timestamp;

  /// Creates a session tree entry.
  const SessionTreeEntry({
    required this.id,
    required this.parentId,
    required this.timestamp,
  });
}

/// A message entry in the session tree.
class MessageEntry extends SessionTreeEntry {
  /// Message role: 'user', 'assistant', or 'toolResult'.
  final String role;

  /// The message content.
  final AgentMessage message;

  /// Creates a message entry.
  const MessageEntry({
    required super.id,
    required super.parentId,
    required super.timestamp,
    required this.role,
    required this.message,
  });
}

/// A thinking level change entry.
class ThinkingLevelChangeEntry extends SessionTreeEntry {
  /// New thinking level.
  final ThinkingLevel level;

  /// Creates a thinking level change entry.
  const ThinkingLevelChangeEntry({
    required super.id,
    required super.parentId,
    required super.timestamp,
    required this.level,
  });
}

/// A model change entry.
class ModelChangeEntry extends SessionTreeEntry {
  /// Provider name.
  final String provider;

  /// New model identifier.
  final String modelId;

  /// Creates a model change entry.
  const ModelChangeEntry({
    required super.id,
    required super.parentId,
    required super.timestamp,
    required this.provider,
    required this.modelId,
  });
}

/// A compaction summary entry.
class CompactionEntry extends SessionTreeEntry {
  /// Generated summary text.
  final String summary;

  /// ID of the first entry kept after compaction.
  final String firstKeptEntryId;

  /// Token count before compaction.
  final int tokensBefore;

  /// Creates a compaction entry.
  const CompactionEntry({
    required super.id,
    required super.parentId,
    required super.timestamp,
    required this.summary,
    required this.firstKeptEntryId,
    required this.tokensBefore,
  });
}

/// A branch summary entry.
class BranchSummaryEntry extends SessionTreeEntry {
  /// Summary of the branch.
  final String summary;

  /// Creates a branch summary entry.
  const BranchSummaryEntry({
    required super.id,
    required super.parentId,
    required super.timestamp,
    required this.summary,
  });
}

/// A label entry applied to a target entry.
class LabelEntry extends SessionTreeEntry {
  /// ID of the entry being labeled.
  final String targetId;

  /// Label text.
  final String? label;

  /// Creates a label entry.
  const LabelEntry({
    required super.id,
    required super.parentId,
    required super.timestamp,
    required this.targetId,
    this.label,
  });
}

/// A custom entry for application-specific data.
class CustomEntry extends SessionTreeEntry {
  /// Custom type identifier.
  final String customType;

  /// Application-specific data.
  final Map<String, dynamic>? data;

  /// Creates a custom entry.
  const CustomEntry({
    required super.id,
    required super.parentId,
    required super.timestamp,
    required this.customType,
    this.data,
  });
}

/// A custom message entry combining custom type with display content.
class CustomMessageEntry extends SessionTreeEntry {
  /// Custom message type.
  final String customType;

  /// Content for LLM consumption.
  final AgentMessage content;

  /// Display text for UI.
  final String display;

  /// Structured details.
  final Map<String, dynamic>? details;

  /// Creates a custom message entry.
  const CustomMessageEntry({
    required super.id,
    required super.parentId,
    required super.timestamp,
    required this.customType,
    required this.content,
    required this.display,
    this.details,
  });
}

/// Session metadata.
class SessionInfo {
  /// Unique session identifier.
  final String id;

  /// Human-readable session name.
  final String name;

  /// When the session was created.
  final DateTime createdAt;

  /// When the session was last updated.
  final DateTime updatedAt;

  /// Additional metadata.
  final Map<String, dynamic> metadata;

  /// Creates session info.
  const SessionInfo({
    required this.id,
    required this.name,
    required this.createdAt,
    required this.updatedAt,
    this.metadata = const {},
  });
}

/// Reconstructed session context.
class SessionContext {
  /// Reconstructed messages.
  final List<AgentMessage> messages;

  /// Current thinking level.
  final ThinkingLevel thinkingLevel;

  /// Current model.
  final Model model;

  /// Creates a session context.
  const SessionContext({
    required this.messages,
    required this.thinkingLevel,
    required this.model,
  });
}

/// Compaction settings.
class CompactionSettings {
  /// Whether compaction is enabled.
  final bool enabled;

  /// Tokens to reserve for the response after compaction.
  final int reserveTokens;

  /// Number of recent tokens to keep during compaction.
  final int keepRecentTokens;

  /// Creates compaction settings.
  const CompactionSettings({
    this.enabled = true,
    this.reserveTokens = 16384,
    this.keepRecentTokens = 20000,
  });
}

/// Result of a compaction operation.
class CompactionResult {
  /// Generated summary text.
  final String summary;

  /// ID of the first entry kept after compaction.
  final String firstKeptEntryId;

  /// Token count before compaction.
  final int tokensBefore;

  /// Creates a compaction result.
  const CompactionResult({
    required this.summary,
    required this.firstKeptEntryId,
    required this.tokensBefore,
  });
}

/// Preparation data for compaction.
class CompactionPreparation {
  /// Index at which to cut the entry list.
  final int cutIndex;

  /// Estimated tokens that will be removed.
  final int tokensCut;

  /// Entries that will be kept.
  final List<SessionTreeEntry> keptEntries;

  /// Entries that will be removed/summarized.
  final List<SessionTreeEntry> cutEntries;

  /// Previous compaction summary, if any.
  final String? previousSummary;

  /// Creates a compaction preparation.
  const CompactionPreparation({
    required this.cutIndex,
    required this.tokensCut,
    required this.keptEntries,
    required this.cutEntries,
    this.previousSummary,
  });
}

/// File operation tracked during compaction.
class FileOperation {
  /// Operation type: 'read', 'write', 'edit'.
  final String type;

  /// File path.
  final String path;

  /// Creates a file operation record.
  const FileOperation({required this.type, required this.path});
}

/// Session info header stored in JSONL files.
class JsonlSessionMetadata {
  /// Unique session identifier.
  final String id;

  /// Human-readable name.
  final String name;

  /// Creation timestamp (ISO 8601 string).
  final String createdAt;

  /// Last updated timestamp (ISO 8601 string).
  final String updatedAt;

  /// Creates JSONL session metadata.
  const JsonlSessionMetadata({
    required this.id,
    required this.name,
    required this.createdAt,
    required this.updatedAt,
  });

  /// Creates from a JSON map.
  factory JsonlSessionMetadata.fromJson(Map<String, dynamic> json) =>
      JsonlSessionMetadata(
        id: json['id'] as String,
        name: json['name'] as String,
        createdAt: json['createdAt'] as String,
        updatedAt: json['updatedAt'] as String,
      );

  /// Converts to a JSON map.
  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'createdAt': createdAt,
        'updatedAt': updatedAt,
      };
}
