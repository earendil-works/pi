/// Low-level agent loop functions.
library;

import 'dart:async';

import 'types.dart';

/// Runs the agent loop with new prompt messages.
///
/// Returns a stream of [AgentEvent]s. The stream completes when
/// the loop finishes (no more tool calls or follow-up messages).
Stream<AgentEvent> agentLoop(
  AgentContext context,
  AgentLoopConfig config,
) =>
    _runLoop(context, config, isNewPrompt: true);

/// Continues the agent loop from existing context.
///
/// Use when resuming from an existing conversation state.
Stream<AgentEvent> agentLoopContinue(
  AgentContext context,
  AgentLoopConfig config,
) =>
    _runLoop(context, config, isNewPrompt: false);

/// Async wrapper that collects all messages from [agentLoop].
Future<List<AgentMessage>> runAgentLoop(
  AgentContext context,
  AgentLoopConfig config,
) async {
  final messages = <AgentMessage>[];
  await for (final event in agentLoop(context, config)) {
    if (event case AgentEnd(messages: final msgs)) {
      messages.addAll(msgs);
    }
  }
  return messages;
}

/// Async wrapper that collects all messages from [agentLoopContinue].
Future<List<AgentMessage>> runAgentLoopContinue(
  AgentContext context,
  AgentLoopConfig config,
) async {
  final messages = <AgentMessage>[];
  await for (final event in agentLoopContinue(context, config)) {
    if (event case AgentEnd(messages: final msgs)) {
      messages.addAll(msgs);
    }
  }
  return messages;
}

Stream<AgentEvent> _runLoop(
  AgentContext context,
  AgentLoopConfig config, {
  required bool isNewPrompt,
}) async* {
  yield const AgentStart();

  List<AgentMessage> currentMessages = List.from(context.messages);
  int turnCount = 0;

  while (true) {
    yield const TurnStart();
    turnCount++;

    // ignore: unused_local_variable
    final converted = await config.convertToLlm(currentMessages);
    final responseMessages = <AgentMessage>[];
    final toolResults = <ToolResultMessage>[];

    final stopReason = responseMessages.isEmpty ? StopReason.endTurn : null;

    if (stopReason == StopReason.toolUse &&
        context.tools != null &&
        context.tools!.isNotEmpty) {
      // Tool execution will happen in agent_loop once LLM client is integrated
    }

    yield TurnEnd(
      message: responseMessages.isNotEmpty
          ? responseMessages.last
          : AssistantMessage(content: [const TextBlock('')]),
      toolResults: toolResults,
    );

    final shouldStop = config.shouldStopAfterTurn?.call(
          ShouldStopAfterTurnContext(
            lastMessage: responseMessages.isNotEmpty
                ? responseMessages.last
                : AssistantMessage(content: [const TextBlock('')]),
            toolResults: toolResults,
            turnCount: turnCount,
          ),
        ) ??
        true;

    if (shouldStop) break;

    final steering = await config.getSteeringMessages?.call() ?? [];
    if (steering.isNotEmpty) {
      currentMessages.addAll(steering);
      continue;
    }

    final followUp = await config.getFollowUpMessages?.call() ?? [];
    if (followUp.isEmpty) break;
    currentMessages.addAll(followUp);
  }

  yield AgentEnd(messages: currentMessages);
}
