import 'dart:async';
import 'dart:convert';
import 'package:test/test.dart';
import 'package:pi/src/sse_parser.dart';

void main() {
  group('parseSSE', () {
    Stream<List<int>> toByteStream(String input) {
      final controller = StreamController<List<int>>();
      controller.add(utf8.encode(input));
      controller.close();
      return controller.stream;
    }

    Stream<List<int>> toChunkedStream(List<String> chunks) {
      final controller = StreamController<List<int>>();
      for (final c in chunks) {
        controller.add(utf8.encode(c));
      }
      controller.close();
      return controller.stream;
    }

    test('parses single event with data field', () async {
      final events = await parseSSE(toByteStream('data: hello\n\n')).toList();
      expect(events, hasLength(1));
      expect(events[0]['data'], 'hello');
    });

    test('parses event with event type', () async {
      final events = await parseSSE(
        toByteStream('event: message\ndata: hello\n\n'),
      ).toList();
      expect(events, hasLength(1));
      expect(events[0]['event'], 'message');
      expect(events[0]['data'], 'hello');
    });

    test('parses event with id field', () async {
      final events = await parseSSE(
        toByteStream('id: 42\ndata: hello\n\n'),
      ).toList();
      expect(events, hasLength(1));
      expect(events[0]['id'], '42');
      expect(events[0]['data'], 'hello');
    });

    test('parses event with retry field', () async {
      final events = await parseSSE(
        toByteStream('retry: 5000\ndata: hello\n\n'),
      ).toList();
      expect(events, hasLength(1));
      expect(events[0]['retry'], '5000');
    });

    test('coalesces multi-line data fields', () async {
      final events = await parseSSE(
        toByteStream('data: line1\ndata: line2\ndata: line3\n\n'),
      ).toList();
      expect(events, hasLength(1));
      expect(events[0]['data'], 'line1\nline2\nline3');
    });

    test('handles data field without space after colon', () async {
      final events = await parseSSE(
        toByteStream('data:no-space\n\n'),
      ).toList();
      expect(events, hasLength(1));
      expect(events[0]['data'], 'no-space');
    });

    test('ignores comment lines', () async {
      final events = await parseSSE(
        toByteStream(': this is a comment\ndata: visible\n\n'),
      ).toList();
      expect(events, hasLength(1));
      expect(events[0]['data'], 'visible');
    });

    test('parses multiple events', () async {
      final events = await parseSSE(
        toByteStream('data: first\n\ndata: second\n\n'),
      ).toList();
      expect(events, hasLength(2));
      expect(events[0]['data'], 'first');
      expect(events[1]['data'], 'second');
    });

    test('emits buffered data on stream close without trailing newline',
        () async {
      final events = await parseSSE(
        toByteStream('data: unfinished'),
      ).toList();
      expect(events, hasLength(1));
      expect(events[0]['data'], 'unfinished');
    });

    test('handles chunked input across event boundaries', () async {
      final events = await parseSSE(
        toChunkedStream(['data: par', 't1\n\nda', 'ta: part2\n\n']),
      ).toList();
      expect(events, hasLength(2));
      expect(events[0]['data'], 'part1');
      expect(events[1]['data'], 'part2');
    });

    test('skips [DONE] sentinel', () async {
      final input = 'data: {"content":"hi"}\n\ndata: [DONE]\n\n';
      final events = await parseSSE(toByteStream(input)).toList();
      expect(events, hasLength(2));
      expect(events[0]['data'], '{"content":"hi"}');
      expect(events[1]['data'], '[DONE]');
    });

    test('handles empty stream', () async {
      final controller = StreamController<List<int>>();
      await controller.close();
      final events = await parseSSE(controller.stream).toList();
      expect(events, isEmpty);
    });

    test('handles blank lines without data', () async {
      final events = await parseSSE(toByteStream('\n\n\n')).toList();
      expect(events, isEmpty);
    });

    test('handles JSON data payload', () async {
      final json = '{"choices":[{"delta":{"content":"Hi"}}]}';
      final events = await parseSSE(toByteStream('data: $json\n\n')).toList();
      expect(events, hasLength(1));
      final decoded = jsonDecode(events[0]['data']!);
      expect(decoded, isA<Map<String, dynamic>>());
    });
  });
}
