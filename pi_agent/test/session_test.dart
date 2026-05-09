import 'package:test/test.dart';
import 'package:pi/src/types.dart';
import 'package:pi/src/session.dart';
import 'package:pi/src/session_storage.dart';

void main() {
  group('Session', () {
    late InMemorySessionStorage storage;
    late Session session;

    setUp(() async {
      storage = InMemorySessionStorage();
      await storage.init();
      session = Session(storage);
    });

    tearDown(() async {
      await storage.close();
    });

    group('appendMessage', () {
      test('appends user message and returns entry id', () async {
        final id = await session.appendMessage(UserMessage.text('hello'));
        expect(id, isNotEmpty);

        final entries = await session.getEntries();
        expect(entries, hasLength(1));
        expect(entries.first, isA<MessageEntry>());
        expect((entries.first as MessageEntry).role, 'user');
      });

      test('appends assistant message', () async {
        final id = await session.appendMessage(
          AssistantMessage(content: [const TextBlock('response')]),
        );
        expect(id, isNotEmpty);

        final entries = await session.getEntries();
        expect(entries, hasLength(1));
        expect((entries.first as MessageEntry).role, 'assistant');
      });

      test('appends tool result message', () async {
        final id = await session.appendMessage(
          ToolResultMessage(
            toolCallId: 'tc1',
            toolName: 'read',
            content: [const TextBlock('file contents')],
          ),
        );
        expect(id, isNotEmpty);

        final entries = await session.getEntries();
        expect((entries.first as MessageEntry).role, 'toolResult');
      });

      test('chaining entries sets parentId', () async {
        final id1 = await session.appendMessage(UserMessage.text('first'));
        await session.appendMessage(UserMessage.text('second'));

        final entries = await session.getEntries();
        expect(entries[1].parentId, id1);
      });
    });

    group('appendThinkingLevelChange', () {
      test('appends thinking level entry', () async {
        final id =
            await session.appendThinkingLevelChange(ThinkingLevel.high);
        expect(id, isNotEmpty);

        final entries = await session.getEntries();
        expect(entries, hasLength(1));
        expect(entries.first, isA<ThinkingLevelChangeEntry>());
        expect(
            (entries.first as ThinkingLevelChangeEntry).level,
            ThinkingLevel.high);
      });
    });

    group('appendModelChange', () {
      test('appends model change entry', () async {
        final id =
            await session.appendModelChange('anthropic', 'claude-3');
        expect(id, isNotEmpty);

        final entries = await session.getEntries();
        expect(entries.first, isA<ModelChangeEntry>());
        final entry = entries.first as ModelChangeEntry;
        expect(entry.provider, 'anthropic');
        expect(entry.modelId, 'claude-3');
      });
    });

    group('appendCompaction', () {
      test('appends compaction entry', () async {
        await session.appendMessage(UserMessage.text('a'));
        final id = await session.appendCompaction(
          'summary text',
          'entry-1',
          1000,
        );
        expect(id, isNotEmpty);

        final entries = await session.getEntries();
        expect(entries.last, isA<CompactionEntry>());
        final entry = entries.last as CompactionEntry;
        expect(entry.summary, 'summary text');
        expect(entry.tokensBefore, 1000);
      });
    });

    group('appendLabel', () {
      test('appends label entry', () async {
        final targetId =
            await session.appendMessage(UserMessage.text('target'));
        final id = await session.appendLabel(targetId, label: 'important');
        expect(id, isNotEmpty);

        final entries = await session.getEntries();
        expect(entries.last, isA<LabelEntry>());
        expect((entries.last as LabelEntry).label, 'important');
        expect((entries.last as LabelEntry).targetId, targetId);
      });
    });

    group('appendCustomEntry', () {
      test('appends custom entry', () async {
        final id = await session.appendCustomEntry(
          'myType',
          data: {'key': 'value'},
        );
        expect(id, isNotEmpty);

        final entries = await session.getEntries();
        expect(entries.last, isA<CustomEntry>());
        final entry = entries.last as CustomEntry;
        expect(entry.customType, 'myType');
        expect(entry.data, {'key': 'value'});
      });
    });

    group('buildContext', () {
      test('returns empty context for empty session', () async {
        final ctx = await session.buildContext();
        expect(ctx.messages, isEmpty);
        expect(ctx.thinkingLevel, ThinkingLevel.off);
      });

      test('reconstructs messages from entries', () async {
        await session.appendMessage(UserMessage.text('hello'));
        await session.appendMessage(
            AssistantMessage(content: [const TextBlock('world')]));

        final ctx = await session.buildContext();
        expect(ctx.messages, hasLength(2));
        expect(ctx.messages.first, isA<UserMessage>());
        expect(ctx.messages.last, isA<AssistantMessage>());
      });

      test('captures thinking level changes', () async {
        await session.appendThinkingLevelChange(ThinkingLevel.high);

        final ctx = await session.buildContext();
        expect(ctx.thinkingLevel, ThinkingLevel.high);
      });

      test('captures model changes', () async {
        await session.appendModelChange('anthropic', 'claude-3');

        final ctx = await session.buildContext();
        expect(ctx.model.modelId, 'claude-3');
      });
    });

    group('getBranch', () {
      test('returns empty for empty session', () async {
        final branch = await session.getBranch();
        expect(branch, isEmpty);
      });

      test('returns entries from leaf to root', () async {
        await session.appendMessage(UserMessage.text('first'));
        await session.appendMessage(UserMessage.text('second'));

        final branch = await session.getBranch();
        expect(branch, hasLength(2));
      });

      test('returns entries in reverse chronological order', () async {
        final id1 =
            await session.appendMessage(UserMessage.text('first'));
        final secondId =
            await session.appendMessage(UserMessage.text('second'));

        final branch = await session.getBranch();
        expect(branch.first.id, secondId);
        expect(branch.last.id, id1);
      });

      test('returns entries from specific id', () async {
        final id1 =
            await session.appendMessage(UserMessage.text('first'));
        final id2 =
            await session.appendMessage(UserMessage.text('second'));

        final branch = await session.getBranch(fromId: id2);
        expect(branch, hasLength(2));
        expect(branch.first.id, id2);
        expect(branch.last.id, id1);
      });
    });

    group('moveTo', () {
    test('moves leaf to specified entry', () async {
      final id1 =
          await session.appendMessage(UserMessage.text('first'));
      await session.appendMessage(UserMessage.text('second'));

      await session.moveTo(id1);

      final branch = await session.getBranch();
      expect(branch.first.id, id1);
    });

      test('creates branch summary when provided', () async {
        final id1 =
            await session.appendMessage(UserMessage.text('first'));
        final summary = await session.moveTo(id1, summary: 'branch point');

        expect(summary, 'branch point');

        final entries = await session.getEntries();
        expect(entries.any((e) => e is BranchSummaryEntry), isTrue);
      });

      test('returns null without summary', () async {
        final id1 =
            await session.appendMessage(UserMessage.text('first'));
        final summary = await session.moveTo(id1);

        expect(summary, isNull);
      });
    });

    group('getEntry', () {
      test('finds entry by id', () async {
        final id = await session.appendMessage(UserMessage.text('test'));
        final entry = await session.getEntry(id);

        expect(entry, isNotNull);
        expect(entry!.id, id);
      });

      test('returns null for missing id', () async {
        final entry = await session.getEntry('nonexistent');
        expect(entry, isNull);
      });
    });

    group('getMetadata', () {
      test('throws when no metadata set', () async {
        expect(() => session.getMetadata(), throwsA(anything));
      });

      test('returns metadata after setting', () async {
        final info = SessionInfo(
          id: 's1',
          name: 'Test Session',
          createdAt: DateTime.now(),
          updatedAt: DateTime.now(),
        );
        await storage.setMetadata(info);
        final result = await session.getMetadata();
        expect(result.id, 's1');
        expect(result.name, 'Test Session');
      });
    });
  });
}
