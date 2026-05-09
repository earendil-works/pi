import 'dart:io' as io;

import 'package:test/test.dart';
import 'package:pi/src/types.dart';
import 'package:pi/src/session_storage.dart';

void main() {
  group('InMemorySessionStorage', () {
    late InMemorySessionStorage storage;

    setUp(() {
      storage = InMemorySessionStorage();
    });

    tearDown(() async {
      await storage.close();
    });

    test('init does nothing', () async {
      await storage.init();
    });

    test('appendEntry and loadEntries', () async {
      final entry = MessageEntry(
        id: 'e1',
        parentId: '',
        timestamp: DateTime.now(),
        role: 'user',
        message: UserMessage.text('hello'),
      );
      await storage.appendEntry(entry);
      final entries = await storage.loadEntries();
      expect(entries, hasLength(1));
      expect(entries.first.id, 'e1');
    });

    test('findEntry returns entry by id', () async {
      final entry = MessageEntry(
        id: 'e1',
        parentId: '',
        timestamp: DateTime.now(),
        role: 'user',
        message: UserMessage.text('hello'),
      );
      await storage.appendEntry(entry);
      final found = await storage.findEntry('e1');
      expect(found, isNotNull);
      expect(found!.id, 'e1');
    });

    test('findEntry returns null for missing id', () async {
      final found = await storage.findEntry('missing');
      expect(found, isNull);
    });

    test('setLeafId and getLeafId', () async {
      await storage.setLeafId('leaf1');
      final leafId = await storage.getLeafId();
      expect(leafId, 'leaf1');
    });

    test('getLeafId returns null initially', () async {
      final leafId = await storage.getLeafId();
      expect(leafId, isNull);
    });

    test('setMetadata and getMetadata', () async {
      final info = SessionInfo(
        id: 's1',
        name: 'Test',
        createdAt: DateTime.now(),
        updatedAt: DateTime.now(),
      );
      await storage.setMetadata(info);
      final result = await storage.getMetadata();
      expect(result.id, 's1');
    });

    test('close clears state', () async {
      await storage.appendEntry(MessageEntry(
        id: 'e1',
        parentId: '',
        timestamp: DateTime.now(),
        role: 'user',
        message: UserMessage.text('hi'),
      ));
      await storage.setLeafId('e1');
      await storage.close();

      final entries = await storage.loadEntries();
      expect(entries, isEmpty);
      expect(await storage.getLeafId(), isNull);
    });

    test('loadEntries returns a copy', () async {
      await storage.appendEntry(MessageEntry(
        id: 'e1',
        parentId: '',
        timestamp: DateTime.now(),
        role: 'user',
        message: UserMessage.text('hi'),
      ));
      final entries1 = await storage.loadEntries();
      final entries2 = await storage.loadEntries();
      expect(identical(entries1, entries2), isFalse);
      expect(entries1.length, entries2.length);
    });
  });

  group('JsonlSessionStorage', () {
    late String tempPath;
    late JsonlSessionStorage storage;

    setUp(() async {
      final tempDir = io.Directory.systemTemp;
      tempPath =
          '${tempDir.path}/pi_agent_test_${DateTime.now().microsecondsSinceEpoch}.jsonl';
      storage = JsonlSessionStorage(tempPath);
      await storage.init();
    });

    tearDown(() async {
      await storage.close();
      final file = io.File(tempPath);
      if (await file.exists()) {
        await file.delete();
      }
    });

    test('init creates file', () async {
      expect(await io.File(tempPath).exists(), isTrue);
    });

    test('appendEntry and loadEntries', () async {
      await storage.appendEntry(MessageEntry(
        id: 'e1',
        parentId: '',
        timestamp: DateTime.now(),
        role: 'user',
        message: UserMessage.text('hello'),
      ));
      final entries = await storage.loadEntries();
      expect(entries, hasLength(1));
    });

    test('persists to disk', () async {
      await storage.appendEntry(MessageEntry(
        id: 'e1',
        parentId: '',
        timestamp: DateTime.now(),
        role: 'user',
        message: UserMessage.text('hello'),
      ));
      await storage.close();

      final storage2 = JsonlSessionStorage(tempPath);
      await storage2.init();
      final entries = await storage2.loadEntries();
      expect(entries, hasLength(1));
      await storage2.close();
    });

    test('findEntry finds by id', () async {
      await storage.appendEntry(MessageEntry(
        id: 'e1',
        parentId: '',
        timestamp: DateTime.now(),
        role: 'user',
        message: UserMessage.text('hello'),
      ));
      final found = await storage.findEntry('e1');
      expect(found, isNotNull);
      expect(found!.id, 'e1');
    });

    test('findEntry returns null for missing', () async {
      final found = await storage.findEntry('nope');
      expect(found, isNull);
    });

    test('setLeafId and getLeafId', () async {
      await storage.setLeafId('leaf1');
      expect(await storage.getLeafId(), 'leaf1');
    });

    test('handles multiple entry types', () async {
      await storage.appendEntry(MessageEntry(
        id: 'e1',
        parentId: '',
        timestamp: DateTime.now(),
        role: 'user',
        message: UserMessage.text('msg'),
      ));
      await storage.appendEntry(ThinkingLevelChangeEntry(
        id: 'e2',
        parentId: 'e1',
        timestamp: DateTime.now(),
        level: ThinkingLevel.high,
      ));
      await storage.appendEntry(ModelChangeEntry(
        id: 'e3',
        parentId: 'e2',
        timestamp: DateTime.now(),
        provider: 'anthropic',
        modelId: 'claude-3',
      ));

      final entries = await storage.loadEntries();
      expect(entries, hasLength(3));
      expect(entries[0], isA<MessageEntry>());
      expect(entries[1], isA<ThinkingLevelChangeEntry>());
      expect(entries[2], isA<ModelChangeEntry>());
    });

    test('handles compaction entries', () async {
      await storage.appendEntry(CompactionEntry(
        id: 'e1',
        parentId: '',
        timestamp: DateTime.now(),
        summary: 'summary',
        firstKeptEntryId: 'e0',
        tokensBefore: 1000,
      ));

      final entries = await storage.loadEntries();
      expect(entries, hasLength(1));
      expect(entries.first, isA<CompactionEntry>());
    });

    test('skips malformed JSON lines on reload', () async {
      final file = io.File(tempPath);
      await file.writeAsString('not valid json\n', mode: io.FileMode.append);
      await storage.appendEntry(MessageEntry(
        id: 'e1',
        parentId: '',
        timestamp: DateTime.now(),
        role: 'user',
        message: UserMessage.text('hello'),
      ));
      await storage.close();

      final storage2 = JsonlSessionStorage(tempPath);
      await storage2.init();
      final entries = await storage2.loadEntries();
      expect(entries, hasLength(1));
      await storage2.close();
    });

    test('skips blank lines on reload', () async {
      final file = io.File(tempPath);
      await file.writeAsString('\n\n', mode: io.FileMode.append);
      await storage.appendEntry(MessageEntry(
        id: 'e1',
        parentId: '',
        timestamp: DateTime.now(),
        role: 'user',
        message: UserMessage.text('hello'),
      ));
      await storage.close();

      final storage2 = JsonlSessionStorage(tempPath);
      await storage2.init();
      final entries = await storage2.loadEntries();
      expect(entries, hasLength(1));
      await storage2.close();
    });

    test('handles label entries', () async {
      await storage.appendEntry(LabelEntry(
        id: 'e1',
        parentId: '',
        timestamp: DateTime.now(),
        targetId: 'target',
        label: 'my-label',
      ));

      final entries = await storage.loadEntries();
      expect(entries, hasLength(1));
      final entry = entries.first as LabelEntry;
      expect(entry.targetId, 'target');
      expect(entry.label, 'my-label');
    });

    test('handles custom entries', () async {
      await storage.appendEntry(CustomEntry(
        id: 'e1',
        parentId: '',
        timestamp: DateTime.now(),
        customType: 'myType',
        data: {'key': 'value'},
      ));

      final entries = await storage.loadEntries();
      expect(entries, hasLength(1));
      final entry = entries.first as CustomEntry;
      expect(entry.customType, 'myType');
      expect(entry.data, {'key': 'value'});
    });

    test('setMetadata and getMetadata', () async {
      final info = SessionInfo(
        id: 's1',
        name: 'Test',
        createdAt: DateTime(2024, 1, 1),
        updatedAt: DateTime(2024, 1, 2),
      );
      await storage.setMetadata(info);
      final result = await storage.getMetadata();
      expect(result.id, 's1');
      expect(result.name, 'Test');
    });
  });
}
