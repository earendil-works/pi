import 'package:test/test.dart';
import 'package:pi/src/types.dart';
import 'package:pi/src/conversion.dart';

void main() {
  group('convertToLlm', () {
    test('converts UserMessage with text only', () async {
      final result = await convertToLlm([UserMessage.text('hello')]);
      expect(result, hasLength(1));
      expect(result.first['role'], 'user');
      expect(result.first['content'], 'hello');
    });

    test('converts UserMessage with image', () async {
      final result = await convertToLlm([
        UserMessage(content: [
          const TextBlock('describe this'),
          const ImageBlock(base64Data: 'abc123', mediaType: 'image/png'),
        ]),
      ]);
      expect(result, hasLength(1));
      expect(result.first['role'], 'user');
      final content = result.first['content'] as List<dynamic>;
      expect(content, hasLength(2));
      expect(content[0]['type'], 'text');
      expect(content[1]['type'], 'image_url');
      expect(content[1]['image_url']['url'], contains('data:image/png'));
    });

    test('converts AssistantMessage with text only', () async {
      final result = await convertToLlm([
        AssistantMessage(content: [const TextBlock('response')])
      ]);
      expect(result, hasLength(1));
      expect(result.first['role'], 'assistant');
      expect(result.first['content'], 'response');
    });

    test('converts AssistantMessage with tool calls', () async {
      final result = await convertToLlm([
        AssistantMessage(content: [
          const TextBlock('let me check'),
          const ToolCallBlock(
            id: 'tc1',
            name: 'read_file',
            arguments: {'path': '/foo'},
          ),
        ]),
      ]);
      expect(result, hasLength(1));
      expect(result.first['role'], 'assistant');
      expect(result.first['tool_calls'], isA<List<dynamic>>());
      expect((result.first['tool_calls'] as List<dynamic>).length, 1);
      final tc = (result.first['tool_calls'] as List<dynamic>).first as Map<String, dynamic>;
      expect(tc['function']['name'], 'read_file');
    });

    test('converts ToolResultMessage', () async {
      final result = await convertToLlm([
        ToolResultMessage(
          toolCallId: 'tc1',
          toolName: 'read',
          content: [const TextBlock('file contents')],
        ),
      ]);
      expect(result, hasLength(1));
      expect(result.first['role'], 'tool');
      expect(result.first['tool_call_id'], 'tc1');
      expect(result.first['content'], 'file contents');
    });

    test('converts ToolResultMessage with error flag', () async {
      final result = await convertToLlm([
        ToolResultMessage(
          toolCallId: 'tc1',
          toolName: 'read',
          content: [const TextBlock('error')],
          isError: true,
        ),
      ]);
      expect(result.first['is_error'], isTrue);
    });

    test('converts CustomMessage', () async {
      final result = await convertToLlm([
        CustomMessage(type: 'note', data: {'x': 1}, display: 'a note'),
      ]);
      expect(result, hasLength(1));
      expect(result.first['role'], 'user');
      expect(result.first['content'], contains('[note]'));
    });

    test('handles mixed message types', () async {
      final result = await convertToLlm([
        UserMessage.text('hello'),
        AssistantMessage(content: [const TextBlock('hi')]),
        UserMessage.text('how are you'),
      ]);
      expect(result, hasLength(3));
      expect(result[0]['role'], 'user');
      expect(result[1]['role'], 'assistant');
      expect(result[2]['role'], 'user');
    });
  });

  group('jsonEncode', () {
    test('encodes strings', () {
      expect(jsonEncode('hello'), '"hello"');
    });

    test('escapes special characters', () {
      expect(jsonEncode('a"b\nc'), '"a\\"b\\nc"');
    });

    test('encodes numbers', () {
      expect(jsonEncode(42), '42');
      expect(jsonEncode(3.14), '3.14');
    });

    test('encodes booleans', () {
      expect(jsonEncode(true), 'true');
      expect(jsonEncode(false), 'false');
    });

    test('encodes null', () {
      expect(jsonEncode(null), 'null');
    });

    test('encodes lists', () {
      expect(jsonEncode([1, 2, 3]), '[1,2,3]');
    });

    test('encodes maps', () {
      final result = jsonEncode({'a': 1});
      expect(result, '{"a":1}');
    });

    test('encodes nested structures', () {
      final result = jsonEncode({
        'list': [1, 'two'],
        'nested': {'key': 'val'},
      });
      expect(result, contains('"list"'));
      expect(result, contains('"nested"'));
    });
  });
}
