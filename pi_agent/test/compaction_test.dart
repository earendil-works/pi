import 'package:test/test.dart';
import 'package:pi/src/types.dart';
import 'package:pi/src/compaction.dart';

void main() {
  group('calculateContextTokens', () {
    test('sums input and output tokens', () {
      final usage = Usage(inputTokens: 100, outputTokens: 50);
      expect(calculateContextTokens(usage), 150);
    });
  });

  group('estimateContextTokens', () {
    test('estimates tokens from messages', () {
      final messages = [
        UserMessage.text('hello world'),
        AssistantMessage(content: [const TextBlock('hi there')]),
      ];
      final tokens = estimateContextTokens(messages);
      expect(tokens, greaterThan(0));
    });

    test('empty messages return zero', () {
      expect(estimateContextTokens([]), 0);
    });

    test('uses chars/4 heuristic', () {
      final text = 'a' * 40;
      final tokens = estimateContextTokens([UserMessage.text(text)]);
      expect(tokens, 10);
    });
  });

  group('shouldCompact', () {
    test('returns true when tokens exceed threshold', () {
      final messages = List.generate(
        100,
        (_) => UserMessage.text('a' * 1000),
      );
      expect(
        shouldCompact(messages, 10000, settings: const CompactionSettings()),
        isTrue,
      );
    });

    test('returns false when tokens within threshold', () {
      final messages = [UserMessage.text('short')];
      expect(
        shouldCompact(messages, 100000),
        isFalse,
      );
    });

    test('returns false when compaction disabled', () {
      final messages = List.generate(
        100,
        (_) => UserMessage.text('a' * 1000),
      );
      expect(
        shouldCompact(
          messages,
          10000,
          settings: const CompactionSettings(enabled: false),
        ),
        isFalse,
      );
    });
  });

  group('findCutPoint', () {
    test('finds cut point for message entries', () {
      final now = DateTime.now();
      final entries = List.generate(
        10,
        (i) => MessageEntry(
          id: 'e$i',
          parentId: i > 0 ? 'e${i - 1}' : '',
          timestamp: now,
          role: 'user',
          message: UserMessage.text('a' * 40),
        ),
      );

      final cutPoint = findCutPoint(entries, 40);
      expect(cutPoint, isNotNull);
      expect(cutPoint!, lessThan(entries.length));
    });

    test('returns null when not enough tokens', () {
      final now = DateTime.now();
      final entries = [
        MessageEntry(
          id: 'e0',
          parentId: '',
          timestamp: now,
          role: 'user',
          message: UserMessage.text('short'),
        ),
      ];

      final cutPoint = findCutPoint(entries, 10000);
      expect(cutPoint, isNull);
    });

    test('skips non-MessageEntry entries', () {
      final now = DateTime.now();
      final entries = <SessionTreeEntry>[
        ThinkingLevelChangeEntry(
          id: 'e0',
          parentId: '',
          timestamp: now,
          level: ThinkingLevel.high,
        ),
        MessageEntry(
          id: 'e1',
          parentId: 'e0',
          timestamp: now,
          role: 'user',
          message: UserMessage.text('a' * 400),
        ),
      ];

      final cutPoint = findCutPoint(entries, 100);
      expect(cutPoint, isNotNull);
      expect(cutPoint, 1);
    });
  });

  group('serializeConversation', () {
    test('serializes user messages', () {
      final result = serializeConversation([UserMessage.text('hello')]);
      expect(result, contains('User: hello'));
    });

    test('serializes assistant messages', () {
      final result = serializeConversation([
        AssistantMessage(content: [const TextBlock('response')])
      ]);
      expect(result, contains('Assistant: response'));
    });

    test('serializes tool result messages', () {
      final result = serializeConversation([
        ToolResultMessage(
          toolCallId: 'tc1',
          toolName: 'read',
          content: [const TextBlock('file content')],
        )
      ]);
      expect(result, contains('Tool: file content'));
    });

    test('serializes custom messages', () {
      final result = serializeConversation([
        CustomMessage(type: 'note', data: {}, display: 'a note'),
      ]);
      expect(result, contains('System: a note'));
    });
  });

  group('prepareCompaction', () {
    test('identifies cut and kept entries', () {
      final now = DateTime.now();
      final entries = List.generate(
        10,
        (i) => MessageEntry(
          id: 'e$i',
          parentId: i > 0 ? 'e${i - 1}' : '',
          timestamp: now,
          role: 'user',
          message: UserMessage.text('a' * 40),
        ),
      );

      final prep = prepareCompaction(entries, 40);
      expect(prep.cutIndex, greaterThanOrEqualTo(0));
      expect(prep.cutEntries.length + prep.keptEntries.length, 10);
      expect(prep.tokensCut, greaterThan(0));
    });

    test('preserves previous summary', () {
      final now = DateTime.now();
      final entries = [
        MessageEntry(
          id: 'e0',
          parentId: '',
          timestamp: now,
          role: 'user',
          message: UserMessage.text('a' * 100),
        ),
      ];

      final prep = prepareCompaction(
        entries,
        10,
        previousSummary: 'old summary',
      );
      expect(prep.previousSummary, 'old summary');
    });
  });

  group('compact', () {
    test('returns compaction result', () async {
      final now = DateTime.now();
      final entries = List.generate(
        10,
        (i) => MessageEntry(
          id: 'e$i',
          parentId: i > 0 ? 'e${i - 1}' : '',
          timestamp: now,
          role: 'user',
          message: UserMessage.text('a' * 40),
        ),
      );

      final result = await compact(
        entries,
        const Model(
            provider: 'openai', modelId: 'gpt-4o', contextWindow: 128000),
        settings: const CompactionSettings(keepRecentTokens: 40),
      );

      expect(result.summary, isNotEmpty);
      expect(result.firstKeptEntryId, isNotEmpty);
    });

    test('includes previous summary in placeholder', () async {
      final now = DateTime.now();
      final entries = [
        MessageEntry(
          id: 'e0',
          parentId: '',
          timestamp: now,
          role: 'user',
          message: UserMessage.text('hello'),
        ),
      ];

      final result = await compact(
        entries,
        const Model(
            provider: 'openai', modelId: 'gpt-4o', contextWindow: 128000),
        settings: const CompactionSettings(keepRecentTokens: 0),
        previousSummary: 'old context',
      );

      expect(result.summary, contains('old context'));
    });
  });
}
