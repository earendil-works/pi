/// Message conversion utilities.
library;

import 'types.dart';

/// Default message converter: filters agent messages to LLM-compatible format.
///
/// Converts UserMessage, AssistantMessage, and ToolResultMessage to
/// the map format expected by OpenAI-compatible and Anthropic APIs.
/// Custom message types are converted to text representations.
Future<List<Map<String, dynamic>>> convertToLlm(
    List<AgentMessage> messages) async {
  final result = <Map<String, dynamic>>[];

  for (final msg in messages) {
    switch (msg) {
      case UserMessage(:final content):
        final textParts =
            content.whereType<TextBlock>().map((b) => b.text).toList();
        final hasImages = content.any((b) => b is ImageBlock);
        if (hasImages) {
          final parts = <Map<String, dynamic>>[];
          for (final block in content) {
            if (block is TextBlock) {
              parts.add({'type': 'text', 'text': block.text});
            } else if (block is ImageBlock) {
              parts.add({
                'type': 'image_url',
                'image_url': {
                  'url': 'data:${block.mediaType};base64,${block.base64Data}'
                },
              });
            }
          }
          result.add({'role': 'user', 'content': parts});
        } else {
          result.add({'role': 'user', 'content': textParts.join()});
        }

      case AssistantMessage(:final content, :final toolCalls):
        if (toolCalls.isNotEmpty) {
          result.add({
            'role': 'assistant',
            'content': content.whereType<TextBlock>().map((b) => b.text).join(),
            'tool_calls': toolCalls
                .map((tc) => {
                      'id': tc.id,
                      'type': 'function',
                      'function': {
                        'name': tc.name,
                        'arguments': jsonEncode(tc.arguments)
                      },
                    })
                .toList(),
          });
        } else {
          result.add({
            'role': 'assistant',
            'content': content.whereType<TextBlock>().map((b) => b.text).join(),
          });
        }

      case ToolResultMessage(:final toolCallId, :final content, :final isError):
        result.add({
          'role': 'tool',
          'tool_call_id': toolCallId,
          'content': content.whereType<TextBlock>().map((b) => b.text).join(),
          if (isError) 'is_error': true,
        });

      case CustomMessage(:final type, :final display):
        result.add({'role': 'user', 'content': '[$type] $display'});
    }
  }

  return result;
}

/// JSON encode helper for tool call arguments.
String jsonEncode(dynamic object) {
  final buffer = StringBuffer();
  _writeJson(object, buffer);
  return buffer.toString();
}

void _writeJson(dynamic object, StringBuffer buffer) {
  if (object == null) {
    buffer.write('null');
  } else if (object is String) {
    buffer.write('"');
    buffer.write(object
        .replaceAll('\\', '\\\\')
        .replaceAll('"', '\\"')
        .replaceAll('\n', '\\n')
        .replaceAll('\r', '\\r')
        .replaceAll('\t', '\\t'));
    buffer.write('"');
  } else if (object is num || object is bool) {
    buffer.write(object);
  } else if (object is List) {
    buffer.write('[');
    for (var i = 0; i < object.length; i++) {
      if (i > 0) buffer.write(',');
      _writeJson(object[i], buffer);
    }
    buffer.write(']');
  } else if (object is Map) {
    buffer.write('{');
    var first = true;
    for (final entry in object.entries) {
      if (!first) buffer.write(',');
      first = false;
      _writeJson(entry.key, buffer);
      buffer.write(':');
      _writeJson(entry.value, buffer);
    }
    buffer.write('}');
  }
}
