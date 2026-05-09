/// Session management for persistent conversations.
library;

import 'dart:async';

import 'types.dart';
import 'session_storage.dart';

/// Session managing conversation history with tree-of-entries structure.
///
/// Supports branching, compaction summaries, and context reconstruction.
class Session {
  final SessionStorage _storage;

  /// Creates a session backed by the given storage.
  Session(this._storage);

  /// Appends a message entry to the session tree.
  Future<String> appendMessage(AgentMessage message) async {
    final leafId = await _storage.getLeafId();
    final id = _createId();
    final entry = MessageEntry(
      id: id,
      parentId: leafId ?? '',
      timestamp: DateTime.now(),
      role: message is UserMessage
          ? 'user'
          : message is AssistantMessage
              ? 'assistant'
              : message is ToolResultMessage
                  ? 'toolResult'
                  : 'custom',
      message: message,
    );
    await _storage.appendEntry(entry);
    await _storage.setLeafId(id);
    return id;
  }

  /// Appends a thinking level change entry.
  Future<String> appendThinkingLevelChange(ThinkingLevel level) async {
    final leafId = await _storage.getLeafId();
    final id = _createId();
    final entry = ThinkingLevelChangeEntry(
      id: id,
      parentId: leafId ?? '',
      timestamp: DateTime.now(),
      level: level,
    );
    await _storage.appendEntry(entry);
    await _storage.setLeafId(id);
    return id;
  }

  /// Appends a model change entry.
  Future<String> appendModelChange(String provider, String modelId) async {
    final leafId = await _storage.getLeafId();
    final id = _createId();
    final entry = ModelChangeEntry(
      id: id,
      parentId: leafId ?? '',
      timestamp: DateTime.now(),
      provider: provider,
      modelId: modelId,
    );
    await _storage.appendEntry(entry);
    await _storage.setLeafId(id);
    return id;
  }

  /// Appends a compaction summary entry.
  Future<String> appendCompaction(
    String summary,
    String firstKeptEntryId,
    int tokensBefore, {
    Map<String, dynamic>? details,
    bool fromHook = false,
  }) async {
    final leafId = await _storage.getLeafId();
    final id = _createId();
    final entry = CompactionEntry(
      id: id,
      parentId: leafId ?? '',
      timestamp: DateTime.now(),
      summary: summary,
      firstKeptEntryId: firstKeptEntryId,
      tokensBefore: tokensBefore,
    );
    await _storage.appendEntry(entry);
    await _storage.setLeafId(id);
    return id;
  }

  /// Appends a label entry.
  Future<String> appendLabel(String targetId, {String? label}) async {
    final leafId = await _storage.getLeafId();
    final id = _createId();
    final entry = LabelEntry(
      id: id,
      parentId: leafId ?? '',
      timestamp: DateTime.now(),
      targetId: targetId,
      label: label,
    );
    await _storage.appendEntry(entry);
    return id;
  }

  /// Appends a custom entry.
  Future<String> appendCustomEntry(String customType,
      {Map<String, dynamic>? data}) async {
    final leafId = await _storage.getLeafId();
    final id = _createId();
    final entry = CustomEntry(
      id: id,
      parentId: leafId ?? '',
      timestamp: DateTime.now(),
      customType: customType,
      data: data,
    );
    await _storage.appendEntry(entry);
    await _storage.setLeafId(id);
    return id;
  }

  /// Reconstructs the session context from the current branch.
  Future<SessionContext> buildContext() async {
    final branch = await getBranch();
    final messages = <AgentMessage>[];
    ThinkingLevel thinkingLevel = ThinkingLevel.off;
    Model? model;

    for (final entry in branch.reversed) {
      switch (entry) {
        case MessageEntry(message: final msg):
          messages.add(msg);
        case ThinkingLevelChangeEntry(level: final lvl):
          thinkingLevel = lvl;
        case ModelChangeEntry(:final provider, :final modelId):
          model = Model(
              provider: provider, modelId: modelId, contextWindow: 128000);
        case CompactionEntry():
          break;
        case BranchSummaryEntry():
          break;
        case LabelEntry():
          break;
        case CustomEntry():
          break;
        case CustomMessageEntry():
          break;
      }
    }

    return SessionContext(
      messages: messages,
      thinkingLevel: thinkingLevel,
      model: model ??
          const Model(
              provider: 'openai', modelId: 'gpt-4o', contextWindow: 128000),
    );
  }

  /// Gets entries from leaf to root (current branch).
  Future<List<SessionTreeEntry>> getBranch({String? fromId}) async {
    final entries = await _storage.loadEntries();
    final entryMap = <String, SessionTreeEntry>{};
    for (final e in entries) {
      entryMap[e.id] = e;
    }

    final leafId = fromId ?? await _storage.getLeafId();
    if (leafId == null) return [];

    final result = <SessionTreeEntry>[];
    String? currentId = leafId;
    while (currentId != null && currentId.isNotEmpty) {
      final entry = entryMap[currentId];
      if (entry == null) break;
      result.add(entry);
      currentId = entry.parentId.isEmpty ? null : entry.parentId;
    }

    return result;
  }

  /// Moves the session leaf to a different branch point.
  ///
  /// Returns the optional summary if this creates a new branch.
  Future<String?> moveTo(String? entryId, {String? summary}) async {
    await _storage.setLeafId(entryId);
    if (summary != null && entryId != null) {
      final id = _createId();
      final entry = BranchSummaryEntry(
        id: id,
        parentId: entryId,
        timestamp: DateTime.now(),
        summary: summary,
      );
      await _storage.appendEntry(entry);
      await _storage.setLeafId(id);
      return summary;
    }
    return null;
  }

  /// Gets all entries in storage.
  Future<List<SessionTreeEntry>> getEntries() async => _storage.loadEntries();

  /// Gets a specific entry by ID.
  Future<SessionTreeEntry?> getEntry(String id) async => _storage.findEntry(id);

  /// Gets session metadata.
  Future<SessionInfo> getMetadata() async => _storage.getMetadata();

  String _createId() => DateTime.now().microsecondsSinceEpoch.toRadixString(36);
}
