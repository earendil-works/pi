/// LLM client for streaming completions.
library;

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'types.dart';
import 'sse_parser.dart';

/// Streams an LLM completion request and returns parsed events.
///
/// Supports OpenAI-compatible and Anthropic API formats.
/// Uses [AbortableRequest] for cancellation support.
Stream<AgentEvent> streamLLM({
  required AgentContext context,
  required AgentLoopConfig config,
  required String apiKey,
  required Completer<void>? abortSignal,
}) async* {
  final isAnthropic = config.model.provider.toLowerCase() == 'anthropic';
  final (url, headers, body) = isAnthropic
      ? _buildAnthropicRequest(context, config, apiKey)
      : _buildOpenAIRequest(context, config, apiKey);

  final client = http.Client();
  try {
    final request = http.Request('POST', url);
    request.headers.addAll(headers);
    request.body = body;

    final responseStream = client.send(request);

    final response = await responseStream;

    if (response.statusCode != 200) {
      final errorBody = await response.stream.bytesToString();
      yield AgentEnd(
        messages: [
          AssistantMessage(
            content: [
              TextBlock('LLM error: ${response.statusCode} - $errorBody')
            ],
          ),
        ],
      );
      return;
    }

    var currentContent = <dynamic>[];
    String? currentMessageId;
    StopReason? stopReason;
    Usage? usage;
    final toolCallBuffers = <String, _ToolCallBuffer>{};

    await for (final event in parseSSE(response.stream)) {
      final data = event['data'];
      if (data == null || data == '[DONE]') continue;

      try {
        final json = jsonDecode(data) as Map<String, dynamic>;

        if (isAnthropic) {
          yield* _handleAnthropicEvent(
            json,
            currentContent,
            toolCallBuffers,
            (id) => currentMessageId = id,
            (sr) => stopReason = sr,
            (u) => usage = u,
          );
        } else {
          yield* _handleOpenAIEvent(
            json,
            currentContent,
            toolCallBuffers,
            (id) => currentMessageId = id,
            (sr) => stopReason = sr,
            (u) => usage = u,
          );
        }
      } catch (_) {
        continue;
      }
    }

    final finalContent = <dynamic>[...currentContent];
    for (final tcb in toolCallBuffers.values) {
      if (tcb.name != null) {
        final args = tcb.argumentsBuffer.isNotEmpty
            ? (jsonDecode(tcb.argumentsBuffer) as Map<String, dynamic>)
            : <String, dynamic>{};
        finalContent
            .add(ToolCallBlock(id: tcb.id, name: tcb.name!, arguments: args));
      }
    }

    final assistantMessage = AssistantMessage(
      id: currentMessageId,
      content: finalContent,
      stopReason: stopReason,
      usage: usage,
    );

    yield MessageEnd(message: assistantMessage);
  } catch (e) {
    if (e is http.RequestAbortedException) return;
    yield AgentEnd(messages: []);
  } finally {
    client.close();
  }
}

(Uri, Map<String, String>, String) _buildOpenAIRequest(
  AgentContext context,
  AgentLoopConfig config,
  String apiKey,
) {
  final url = Uri.parse('https://api.openai.com/v1/chat/completions');
  final headers = <String, String>{
    'Authorization': 'Bearer $apiKey',
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  };

  final body = jsonEncode({
    'model': config.model.modelId,
    'messages': [
      {'role': 'system', 'content': context.systemPrompt},
      ...?context.tools != null && context.tools!.isNotEmpty ? null : null,
    ],
    'stream': true,
    if (config.maxTokens != null) 'max_tokens': config.maxTokens,
    if (config.temperature != null) 'temperature': config.temperature,
    if (config.topP != null) 'top_p': config.topP,
    if (context.tools != null && context.tools!.isNotEmpty)
      'tools': context.tools!
          .map((t) => (t as dynamic).toApiFormat() as Map<String, dynamic>)
          .toList(),
  });

  return (url, headers, body);
}

(Uri, Map<String, String>, String) _buildAnthropicRequest(
  AgentContext context,
  AgentLoopConfig config,
  String apiKey,
) {
  final url = Uri.parse('https://api.anthropic.com/v1/messages');
  final headers = <String, String>{
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  };

  final body = jsonEncode({
    'model': config.model.modelId,
    'max_tokens': config.maxTokens ?? 4096,
    'system': context.systemPrompt,
    'messages': [],
    'stream': true,
    if (config.temperature != null) 'temperature': config.temperature,
    if (config.topP != null) 'top_p': config.topP,
    if (context.tools != null && context.tools!.isNotEmpty)
      'tools': context.tools!
          .map((t) => (t as dynamic).toApiFormat() as Map<String, dynamic>)
          .toList(),
  });

  return (url, headers, body);
}

Stream<AgentEvent> _handleOpenAIEvent(
  Map<String, dynamic> json,
  List<dynamic> currentContent,
  Map<String, _ToolCallBuffer> toolCallBuffers,
  void Function(String?) setId,
  void Function(StopReason) setStopReason,
  void Function(Usage) setUsage,
) async* {
  final choices = json['choices'] as List<dynamic>?;
  if (choices == null || choices.isEmpty) return;

  final choice = choices[0] as Map<String, dynamic>;
  final delta = choice['delta'] as Map<String, dynamic>?;
  if (delta == null) return;

  if (delta.containsKey('content') && delta['content'] != null) {
    final text = delta['content'] as String;
    final textBlock = TextBlock(text);
    currentContent.add(textBlock);

    final msg = AssistantMessage(content: List.from(currentContent));
    yield MessageUpdate(message: msg);
  }

  final toolCalls = delta['tool_calls'] as List<dynamic>?;
  if (toolCalls != null) {
    for (final tc in toolCalls) {
      final tcMap = tc as Map<String, dynamic>;
      final index = tcMap['index'] as int;
      final id = tcMap['id'] as String?;
      final function = tcMap['function'] as Map<String, dynamic>?;

      final key = '$index';
      toolCallBuffers.putIfAbsent(
          key, () => _ToolCallBuffer(id: id ?? '', argumentsBuffer: ''));
      final buffer = toolCallBuffers[key]!;

      if (id != null) buffer.id = id;
      if (function != null) {
        if (function.containsKey('name') && function['name'] != null) {
          buffer.name = function['name'] as String;
        }
        if (function.containsKey('arguments') &&
            function['arguments'] != null) {
          buffer.argumentsBuffer += function['arguments'] as String;
        }
      }
    }
  }

  final finishReason = choice['finish_reason'] as String?;
  if (finishReason != null) {
    setStopReason(_parseStopReason(finishReason));
  }

  final usage = json['usage'] as Map<String, dynamic>?;
  if (usage != null) {
    setUsage(Usage(
      inputTokens: usage['prompt_tokens'] as int? ?? 0,
      outputTokens: usage['completion_tokens'] as int? ?? 0,
    ));
  }
}

Stream<AgentEvent> _handleAnthropicEvent(
  Map<String, dynamic> json,
  List<dynamic> currentContent,
  Map<String, _ToolCallBuffer> toolCallBuffers,
  void Function(String?) setId,
  void Function(StopReason) setStopReason,
  void Function(Usage) setUsage,
) async* {
  final type = json['type'] as String;

  switch (type) {
    case 'message_start':
      final message = json['message'] as Map<String, dynamic>?;
      if (message != null) {
        setId(message['id'] as String?);
        final msgUsage = message['usage'] as Map<String, dynamic>?;
        if (msgUsage != null) {
          setUsage(Usage(
            inputTokens: msgUsage['input_tokens'] as int? ?? 0,
            outputTokens: msgUsage['output_tokens'] as int? ?? 0,
          ));
        }
      }

    case 'content_block_start':
      final index = json['index'] as int;
      final contentBlock = json['content_block'] as Map<String, dynamic>?;
      if (contentBlock != null) {
        final blockType = contentBlock['type'] as String;
        if (blockType == 'tool_use') {
          final id = contentBlock['id'] as String;
          final name = contentBlock['name'] as String;
          toolCallBuffers['$index'] = _ToolCallBuffer(
            id: id,
            name: name,
            argumentsBuffer: '',
          );
        }
      }

    case 'content_block_delta':
      final delta = json['delta'] as Map<String, dynamic>?;
      final index = json['index'] as int;
      if (delta != null) {
        final deltaType = delta['type'] as String;
        if (deltaType == 'text_delta') {
          final text = delta['text'] as String;
          currentContent.add(TextBlock(text));
          yield MessageUpdate(
            message: AssistantMessage(content: List.from(currentContent)),
          );
        } else if (deltaType == 'thinking_delta') {
          final thinking = delta['thinking'] as String;
          currentContent.add(ThinkingBlock(thinking));
        } else if (deltaType == 'input_json_delta') {
          final partialJson = delta['partial_json'] as String;
          final key = '$index';
          toolCallBuffers.putIfAbsent(
              key, () => _ToolCallBuffer(id: '', argumentsBuffer: ''));
          toolCallBuffers[key]!.argumentsBuffer += partialJson;
        }
      }

    case 'message_delta':
      final delta = json['delta'] as Map<String, dynamic>?;
      if (delta != null) {
        final stopReasonStr = delta['stop_reason'] as String?;
        if (stopReasonStr != null) {
          setStopReason(_parseStopReason(stopReasonStr));
        }
      }
      final msgUsage = json['usage'] as Map<String, dynamic>?;
      if (msgUsage != null) {
        setUsage(Usage(
          inputTokens: 0,
          outputTokens: msgUsage['output_tokens'] as int? ?? 0,
        ));
      }

    case 'message_stop':
      break;
  }
}

StopReason _parseStopReason(String reason) => switch (reason) {
      'stop' || 'end_turn' => StopReason.endTurn,
      'length' || 'max_tokens' => StopReason.maxTokens,
      'tool_calls' || 'tool_use' => StopReason.toolUse,
      'content_filter' || 'refusal' => StopReason.refused,
      _ => StopReason.endTurn,
    };

class _ToolCallBuffer {
  String id;
  String? name;
  String argumentsBuffer;

  _ToolCallBuffer({
    required this.id,
    this.name,
    required this.argumentsBuffer,
  });
}
