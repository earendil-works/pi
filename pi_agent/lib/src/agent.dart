/// Agent class - stateful wrapper around the agent loop.
///
/// See full implementation in Phase 4 tasks.
library;

import 'dart:async';

import 'types.dart';

/// Callback type for agent event listeners.
typedef AgentEventListener = FutureOr<void> Function(AgentEvent event);

/// Options for constructing an Agent.
class AgentOptions {
  /// Initial model.
  final Model? model;

  /// Initial system prompt.
  final String? systemPrompt;

  /// Initial thinking level.
  final ThinkingLevel? thinkingLevel;

  /// Initial tools.
  final List<AgentTool<dynamic, dynamic>>? tools;

  /// Initial messages.
  final List<AgentMessage>? messages;

  /// Session identifier.
  final String? sessionId;

  /// Custom stream function (default: uses LLM client).
  final Stream<AgentEvent> Function(
      AgentContext context, AgentLoopConfig config)? streamFn;

  /// Custom message converter.
  final Future<List<Map<String, dynamic>>> Function(List<AgentMessage>)?
      convertToLlm;

  /// Custom context transformer.
  final Future<List<AgentMessage>> Function(List<AgentMessage>,
      {bool Function()? isAborted})? transformContext;

  /// API key resolver.
  final Future<String?> Function(String provider)? getApiKey;

  /// Before tool call hook.
  final Future<BeforeToolCallResult?> Function(BeforeToolCallContext,
      {bool Function()? isAborted})? beforeToolCall;

  /// After tool call hook.
  final Future<AfterToolCallResult?> Function(AfterToolCallContext,
      {bool Function()? isAborted})? afterToolCall;

  /// Tool execution mode.
  final ToolExecutionMode? toolExecution;

  /// Steering mode.
  final SteeringMode? steeringMode;

  /// Follow-up mode.
  final FollowUpMode? followUpMode;

  /// Thinking budget tokens per level.
  final Map<ThinkingLevel, int>? thinkingBudgets;

  /// Extra headers for LLM requests.
  final Map<String, String>? extraHeaders;

  /// Creates agent options.
  const AgentOptions({
    this.model,
    this.systemPrompt,
    this.thinkingLevel,
    this.tools,
    this.messages,
    this.sessionId,
    this.streamFn,
    this.convertToLlm,
    this.transformContext,
    this.getApiKey,
    this.beforeToolCall,
    this.afterToolCall,
    this.toolExecution,
    this.steeringMode,
    this.followUpMode,
    this.thinkingBudgets,
    this.extraHeaders,
  });
}

/// Stateful agent managing conversation lifecycle, tool execution, and events.
///
/// The Agent wraps the low-level agent loop with:
/// - Mutable state management (tools, messages, system prompt)
/// - Event subscription system
/// - Steering and follow-up message queues
/// - Abort/cancellation support
class Agent {
  final AgentState _state;
  final String? _sessionId;
  Stream<AgentEvent> Function(AgentContext context, AgentLoopConfig config)?
      _streamFn;
  Future<List<Map<String, dynamic>>> Function(List<AgentMessage>)?
      _convertToLlm;
  Future<List<AgentMessage>> Function(List<AgentMessage>,
      {bool Function()? isAborted})? _transformContext;
  Future<String?> Function(String provider)? _getApiKey;
  Future<BeforeToolCallResult?> Function(BeforeToolCallContext,
      {bool Function()? isAborted})? _beforeToolCall;
  Future<AfterToolCallResult?> Function(AfterToolCallContext,
      {bool Function()? isAborted})? _afterToolCall;
  ToolExecutionMode _toolExecution;
  // ignore: unused_field
  SteeringMode _steeringMode;
  // ignore: unused_field
  FollowUpMode _followUpMode;
  // ignore: unused_field
  final Map<ThinkingLevel, int>? _thinkingBudgets;
  final Map<String, String>? _extraHeaders;

  final List<AgentEventListener> _listeners = [];
  final List<AgentMessage> _steeringQueue = [];
  final List<AgentMessage> _followUpQueue = [];
  Completer<void>? _abortCompleter;
  bool _isRunning = false;
  Future<void>? _activeRun;

  /// Creates an agent.
  ///
  /// Optionally accepts [AgentOptions] or individual parameters.
  Agent({
    AgentOptions? options,
    Model? model,
    String? systemPrompt,
    ThinkingLevel? thinkingLevel,
    List<AgentTool<dynamic, dynamic>>? tools,
    List<AgentMessage>? messages,
    String? sessionId,
    Stream<AgentEvent> Function(AgentContext context, AgentLoopConfig config)?
        streamFn,
    Future<List<Map<String, dynamic>>> Function(List<AgentMessage>)?
        convertToLlm,
    Future<List<AgentMessage>> Function(List<AgentMessage>,
            {bool Function()? isAborted})?
        transformContext,
    Future<String?> Function(String provider)? getApiKey,
    Future<BeforeToolCallResult?> Function(BeforeToolCallContext,
            {bool Function()? isAborted})?
        beforeToolCall,
    Future<AfterToolCallResult?> Function(AfterToolCallContext,
            {bool Function()? isAborted})?
        afterToolCall,
    ToolExecutionMode? toolExecution,
    SteeringMode? steeringMode,
    FollowUpMode? followUpMode,
    Map<ThinkingLevel, int>? thinkingBudgets,
    Map<String, String>? extraHeaders,
  })  : _sessionId = options?.sessionId ?? sessionId,
        _streamFn = options?.streamFn ?? streamFn,
        _convertToLlm = options?.convertToLlm ?? convertToLlm,
        _transformContext = options?.transformContext ?? transformContext,
        _getApiKey = options?.getApiKey ?? getApiKey,
        _beforeToolCall = options?.beforeToolCall ?? beforeToolCall,
        _afterToolCall = options?.afterToolCall ?? afterToolCall,
        _toolExecution = options?.toolExecution ??
            toolExecution ??
            ToolExecutionMode.parallel,
        _steeringMode =
            options?.steeringMode ?? steeringMode ?? SteeringMode.oneAtATime,
        _followUpMode =
            options?.followUpMode ?? followUpMode ?? FollowUpMode.oneAtATime,
        _thinkingBudgets = options?.thinkingBudgets ?? thinkingBudgets,
        _extraHeaders = options?.extraHeaders ?? extraHeaders,
        _state = AgentState(
          systemPrompt: options?.systemPrompt ?? systemPrompt ?? '',
          model: options?.model ??
              model ??
              const Model(
                  provider: 'openai', modelId: 'gpt-4o', contextWindow: 128000),
          thinkingLevel:
              options?.thinkingLevel ?? thinkingLevel ?? ThinkingLevel.off,
          tools: options?.tools ?? tools ?? [],
          messages: options?.messages ?? messages ?? [],
        );

  /// Current agent state.
  AgentState get state => _state;

  /// Whether the agent is currently running.
  bool get isRunning => _isRunning;

  /// Session identifier.
  String? get sessionId => _sessionId;

  /// Sets the message converter.
  set convertToLlm(
          Future<List<Map<String, dynamic>>> Function(List<AgentMessage>)?
              fn) =>
      _convertToLlm = fn;

  /// Sets the context transformer.
  set transformContext(
          Future<List<AgentMessage>> Function(List<AgentMessage>,
                  {bool Function()? isAborted})?
              fn) =>
      _transformContext = fn;

  /// Sets the stream function.
  set streamFn(
          Stream<AgentEvent> Function(
                  AgentContext context, AgentLoopConfig config)?
              fn) =>
      _streamFn = fn;

  /// Sets the API key resolver.
  set getApiKey(Future<String?> Function(String provider)? fn) =>
      _getApiKey = fn;

  /// Sets the before-tool-call hook.
  set beforeToolCall(
          Future<BeforeToolCallResult?> Function(BeforeToolCallContext,
                  {bool Function()? isAborted})?
              fn) =>
      _beforeToolCall = fn;

  /// Sets the after-tool-call hook.
  set afterToolCall(
          Future<AfterToolCallResult?> Function(AfterToolCallContext,
                  {bool Function()? isAborted})?
              fn) =>
      _afterToolCall = fn;

  /// Sets tool execution mode.
  set toolExecution(ToolExecutionMode mode) => _toolExecution = mode;

  /// Sets steering mode.
  set steeringMode(SteeringMode mode) => _steeringMode = mode;

  /// Sets follow-up mode.
  set followUpMode(FollowUpMode mode) => _followUpMode = mode;

  /// Subscribe to agent events.
  ///
  /// Returns an unsubscribe function. Listeners are called sequentially
  /// and awaited before the agent is considered idle.
  void Function() subscribe(AgentEventListener listener,
      {void Function()? onCancel}) {
    _listeners.add(listener);
    return () => _listeners.remove(listener);
  }

  /// Start a new conversation by sending a prompt.
  ///
  /// [input] can be a `String`, `List<ContentBlock>`, `AgentMessage`, or
  /// `List<AgentMessage>`.
  Future<void> prompt(dynamic input) async {
    if (_isRunning) {
      throw StateError(
          'Agent is already running. Call abort() or waitForIdle() first.');
    }

    final msgs = _inputToMessages(input);
    _state.internalMessages.addAll(msgs);
    await _run();
  }

  /// Continue the conversation from the current transcript.
  ///
  /// The last message must be a user or tool result message.
  Future<void> continue_() async {
    if (_isRunning) {
      throw StateError(
          'Agent is already running. Call abort() or waitForIdle() first.');
    }

    if (_state.internalMessages.isEmpty) {
      throw StateError('Cannot continue: transcript is empty.');
    }

    await _run();
  }

  /// Queue a steering message to be injected during the next turn.
  void steer(AgentMessage message) => _steeringQueue.add(message);

  /// Queue a follow-up message to be injected after the current turn.
  void followUp(AgentMessage message) => _followUpQueue.add(message);

  /// Clear all queued steering messages.
  void clearSteeringQueue() => _steeringQueue.clear();

  /// Clear all queued follow-up messages.
  void clearFollowUpQueue() => _followUpQueue.clear();

  /// Clear all queued messages.
  void clearAllQueues() {
    _steeringQueue.clear();
    _followUpQueue.clear();
  }

  /// Whether there are any queued messages.
  bool hasQueuedMessages() =>
      _steeringQueue.isNotEmpty || _followUpQueue.isNotEmpty;

  /// Abort the current agent run.
  void abort() {
    _abortCompleter?.complete();
  }

  /// Wait for the agent to become idle after a run completes.
  Future<void> waitForIdle() async {
    await _activeRun;
  }

  /// Reset the agent state, clearing transcript and queues.
  void reset() {
    _state.internalMessages.clear();
    _steeringQueue.clear();
    _followUpQueue.clear();
    _state.errorMessage = null;
    _state.isStreaming = false;
    _state.streamingMessage = null;
    _state.internalPendingToolCalls.clear();
  }

  List<AgentMessage> _inputToMessages(dynamic input) {
    if (input is String) return [UserMessage.text(input)];
    if (input is List<ContentBlock>) return [UserMessage(content: input)];
    if (input is AgentMessage) return [input];
    if (input is List<AgentMessage>) return input;
    throw ArgumentError('Unsupported input type: ${input.runtimeType}');
  }

  Future<void> _run() async {
    _isRunning = true;
    _abortCompleter = Completer<void>();
    _state.isStreaming = true;
    _state.errorMessage = null;

    try {
      await _emitEvent(AgentStart(sessionId: _sessionId));

      final config = _buildConfig();
      final context = AgentContext(
        systemPrompt: _state.systemPrompt,
        messages: List.from(_state.internalMessages),
        tools: _state.internalTools.isNotEmpty
            ? List.from(_state.internalTools)
            : null,
      );

      final streamFn = _streamFn ?? _defaultStreamFn;
      final eventStream = streamFn(context, config);

      await for (final event in eventStream) {
        if (_abortCompleter?.isCompleted ?? false) break;
        _handleEvent(event);
        await _emitEvent(event);
      }

      await _emitEvent(AgentEnd(messages: List.from(_state.internalMessages)));
    } catch (e) {
      _state.errorMessage = e.toString();
      await _emitEvent(AgentEnd(messages: List.from(_state.internalMessages)));
    } finally {
      _state.isStreaming = false;
      _state.streamingMessage = null;
      _isRunning = false;
      _abortCompleter = null;
    }
  }

  void _handleEvent(AgentEvent event) {
    switch (event) {
      case MessageStart(message: final msg):
        _state.streamingMessage = msg;
      case MessageUpdate(message: final msg):
        _state.streamingMessage = msg;
      case MessageEnd(message: final msg):
        _state.internalMessages.add(msg);
        _state.streamingMessage = null;
      case ToolExecutionStart(toolCallId: final id):
        _state.internalPendingToolCalls.add(id);
      case ToolExecutionEnd(toolCallId: final id):
        _state.internalPendingToolCalls.remove(id);
      default:
        break;
    }
  }

  Future<void> _emitEvent(AgentEvent event) async {
    for (final listener in _listeners) {
      await listener(event);
    }
  }

  AgentLoopConfig _buildConfig() => AgentLoopConfig(
        model: _state.model,
        toolExecution: _toolExecution,
        convertToLlm: _convertToLlm ?? _defaultConvertToLlm,
        transformContext: _transformContext,
        getApiKey: _getApiKey,
        beforeToolCall: _beforeToolCall,
        afterToolCall: _afterToolCall,
        shouldStopAfterTurn: null,
        getSteeringMessages: _steeringQueue.isNotEmpty
            ? () async => _drainQueue(_steeringQueue)
            : null,
        getFollowUpMessages: _followUpQueue.isNotEmpty
            ? () async => _drainQueue(_followUpQueue)
            : null,
        extraHeaders: _extraHeaders,
      );

  List<AgentMessage> _drainQueue(List<AgentMessage> queue) {
    final msgs = List<AgentMessage>.from(queue);
    queue.clear();
    return msgs;
  }

  Stream<AgentEvent> _defaultStreamFn(
      AgentContext context, AgentLoopConfig config) {
    return Stream.empty();
  }

  Future<List<Map<String, dynamic>>> _defaultConvertToLlm(
      List<AgentMessage> msgs) async {
    return msgs
        .whereType<UserMessage>()
        .map((m) => {
              'role': 'user',
              'content':
                  m.content.whereType<TextBlock>().map((b) => b.text).join(),
            })
        .toList();
  }
}
