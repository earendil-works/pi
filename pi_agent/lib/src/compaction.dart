/// Context compaction utilities.
library;

import 'types.dart';

/// Default compaction settings.
const CompactionSettings defaultCompactionSettings = CompactionSettings();

/// Calculates context tokens from a [Usage] object.
int calculateContextTokens(Usage usage) =>
    usage.inputTokens + usage.outputTokens;

/// Estimates context tokens from a list of messages.
///
/// Uses a chars/4 heuristic per message when usage data is unavailable.
int estimateContextTokens(List<AgentMessage> messages) {
  var total = 0;
  for (final msg in messages) {
    total += _estimateMessageTokens(msg);
  }
  return total;
}

/// Checks if compaction should be triggered based on estimated tokens.
bool shouldCompact(
  List<AgentMessage> messages,
  int contextWindow, {
  CompactionSettings settings = defaultCompactionSettings,
}) {
  if (!settings.enabled) return false;
  final estimated = estimateContextTokens(messages);
  return estimated > contextWindow - settings.reserveTokens;
}

/// Finds the cut point index in entries to keep [keepTokens] recent tokens.
///
/// Walks entries from leaf backward and returns the index where older
/// entries should be summarized.
int? findCutPoint(
  List<SessionTreeEntry> entries,
  int keepTokens, {
  int startIndex = 0,
}) {
  var accumulated = 0;
  for (var i = entries.length - 1; i >= startIndex; i--) {
    final entry = entries[i];
    if (entry is MessageEntry) {
      accumulated += _estimateMessageTokens(entry.message);
    }
    if (accumulated >= keepTokens) {
      return i;
    }
  }
  return null;
}

/// Serializes messages to text for summarization.
String serializeConversation(List<AgentMessage> messages) {
  final buffer = StringBuffer();
  for (final msg in messages) {
    final role = switch (msg) {
      UserMessage() => 'User',
      AssistantMessage() => 'Assistant',
      ToolResultMessage() => 'Tool',
      CustomMessage() => 'System',
    };
    final text = switch (msg) {
      UserMessage(:final content) =>
        content.whereType<TextBlock>().map((b) => b.text).join(),
      AssistantMessage(:final content) =>
        content.whereType<TextBlock>().map((b) => b.text).join(),
      ToolResultMessage(:final content) =>
        content.whereType<TextBlock>().map((b) => b.text).join(),
      CustomMessage(:final display) => display,
    };
    buffer.writeln('$role: $text');
    buffer.writeln();
  }
  return buffer.toString();
}

/// Prepares compaction by identifying the cut point and categorizing entries.
CompactionPreparation prepareCompaction(
  List<SessionTreeEntry> entries,
  int keepTokens, {
  String? previousSummary,
}) {
  final cutIndex = findCutPoint(entries, keepTokens) ?? 0;
  var tokensCut = 0;
  for (var i = 0; i < cutIndex; i++) {
    final entry = entries[i];
    if (entry is MessageEntry) {
      tokensCut += _estimateMessageTokens(entry.message);
    }
  }

  return CompactionPreparation(
    cutIndex: cutIndex,
    tokensCut: tokensCut,
    keptEntries: entries.sublist(cutIndex),
    cutEntries: entries.sublist(0, cutIndex),
    previousSummary: previousSummary,
  );
}

/// Runs full compaction: find cut point, generate summary, return result.
///
/// Note: Actual LLM-based summarization requires the LLM client integration.
/// This implementation uses a placeholder summary.
Future<CompactionResult> compact(
  List<SessionTreeEntry> entries,
  Model model, {
  String? apiKey,
  CompactionSettings? settings,
  String? customInstructions,
  String? previousSummary,
}) async {
  settings ??= defaultCompactionSettings;
  final preparation = prepareCompaction(
    entries,
    settings.keepRecentTokens,
    previousSummary: previousSummary,
  );

  final messages = preparation.cutEntries
      .whereType<MessageEntry>()
      .map((e) => e.message)
      .toList();

  final serialized = serializeConversation(messages);
  final summary = _generatePlaceholderSummary(serialized, previousSummary);

  final firstKeptEntryId = preparation.keptEntries.isNotEmpty
      ? preparation.keptEntries.first.id
      : '';

  return CompactionResult(
    summary: summary,
    firstKeptEntryId: firstKeptEntryId,
    tokensBefore: preparation.tokensCut,
  );
}

int _estimateMessageTokens(AgentMessage message) {
  final text = switch (message) {
    UserMessage(:final content) =>
      content.whereType<TextBlock>().map((b) => b.text).join(),
    AssistantMessage(:final content) =>
      content.whereType<TextBlock>().map((b) => b.text).join(),
    ToolResultMessage(:final content) =>
      content.whereType<TextBlock>().map((b) => b.text).join(),
    CustomMessage(:final display) => display,
  };
  return (text.length / 4).ceil();
}

String _generatePlaceholderSummary(String serialized, String? previousSummary) {
  final buffer = StringBuffer();
  if (previousSummary != null) {
    buffer.writeln('Previous context: $previousSummary');
    buffer.writeln();
  }
  buffer.writeln('Summary of earlier conversation:');
  buffer.writeln(serialized.length > 2000
      ? '${serialized.substring(0, 2000)}...'
      : serialized);
  return buffer.toString();
}
