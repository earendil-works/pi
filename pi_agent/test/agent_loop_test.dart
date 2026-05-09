import 'dart:async';

import 'package:test/test.dart';
import 'package:pi/src/types.dart';
import 'package:pi/src/agent_loop.dart';

AgentLoopConfig _testConfig({
  Future<List<Map<String, dynamic>>> Function(List<AgentMessage>)? convertToLlm,
  bool Function(ShouldStopAfterTurnContext)? shouldStopAfterTurn,
  Future<List<AgentMessage>> Function()? getSteeringMessages,
  Future<List<AgentMessage>> Function()? getFollowUpMessages,
}) =>
    AgentLoopConfig(
      model: const Model(
          provider: 'openai', modelId: 'gpt-4o', contextWindow: 128000),
      convertToLlm: convertToLlm ??
          (msgs) async =>
              msgs.map((m) => {'role': 'user', 'content': 'test'}).toList(),
      shouldStopAfterTurn: shouldStopAfterTurn,
      getSteeringMessages: getSteeringMessages,
      getFollowUpMessages: getFollowUpMessages,
    );

AgentContext _testContext({List<AgentMessage>? messages}) => AgentContext(
      systemPrompt: 'test',
      messages: messages ?? [UserMessage.text('hello')],
    );

void main() {
  group('agentLoop', () {
    test('emits AgentStart and AgentEnd', () async {
      final events = await agentLoop(
        _testContext(),
        _testConfig(),
      ).toList();

      expect(events.first, isA<AgentStart>());
      expect(events.last, isA<AgentEnd>());
    });

    test('emits TurnStart and TurnEnd per turn', () async {
      final events = await agentLoop(
        _testContext(),
        _testConfig(),
      ).toList();

      expect(events.whereType<TurnStart>(), isNotEmpty);
      expect(events.whereType<TurnEnd>(), isNotEmpty);
    });

    test('defaults to stopping after first turn', () async {
      final events = await agentLoop(
        _testContext(),
        _testConfig(),
      ).toList();

      expect(events.whereType<TurnEnd>(), hasLength(1));
    });

    test('shouldStopAfterTurn returning false continues loop', () async {
      var followUpCalls = 0;

      final events = await agentLoop(
        _testContext(),
        _testConfig(
          shouldStopAfterTurn: (ctx) => false,
          getFollowUpMessages: () async {
            followUpCalls++;
            if (followUpCalls <= 2) {
              return [UserMessage.text('follow-up $followUpCalls')];
            }
            return [];
          },
        ),
      ).toList();

      expect(events.whereType<TurnEnd>().length, greaterThanOrEqualTo(2));
    });
  });

  group('agentLoopContinue', () {
    test('emits events from existing context', () async {
      final events = await agentLoopContinue(
        _testContext(),
        _testConfig(),
      ).toList();

      expect(events.first, isA<AgentStart>());
      expect(events.last, isA<AgentEnd>());
    });
  });

  group('runAgentLoop', () {
    test('collects messages from AgentEnd event', () async {
      final messages = await runAgentLoop(
        _testContext(),
        _testConfig(),
      );

      expect(messages, isA<List<AgentMessage>>());
    });
  });

  group('runAgentLoopContinue', () {
    test('collects messages from AgentEnd event', () async {
      final messages = await runAgentLoopContinue(
        _testContext(),
        _testConfig(),
      );

      expect(messages, isA<List<AgentMessage>>());
    });
  });

  group('steering messages', () {
    test('steering messages extend the loop', () async {
      var steeringCalls = 0;
      await agentLoop(
        _testContext(),
        _testConfig(
          shouldStopAfterTurn: (ctx) => false,
          getSteeringMessages: () async {
            steeringCalls++;
            if (steeringCalls <= 2) {
              return [UserMessage.text('steer $steeringCalls')];
            }
            return [];
          },
        ),
      ).toList();

      expect(steeringCalls, greaterThanOrEqualTo(1));
    });
  });

  group('follow-up messages', () {
    test('follow-up messages extend the loop', () async {
      var followUpCalls = 0;
      await agentLoop(
        _testContext(),
        _testConfig(
          shouldStopAfterTurn: (ctx) => false,
          getFollowUpMessages: () async {
            followUpCalls++;
            if (followUpCalls <= 1) {
              return [UserMessage.text('follow-up')];
            }
            return [];
          },
        ),
      ).toList();

      expect(followUpCalls, greaterThanOrEqualTo(1));
    });
  });

  group('convertToLlm integration', () {
    test('calls convertToLlm with context messages', () async {
      List<AgentMessage>? captured;
      await agentLoop(
        _testContext(messages: [UserMessage.text('hello')]),
        _testConfig(
          convertToLlm: (msgs) async {
            captured = msgs;
            return [];
          },
        ),
      ).toList();

      expect(captured, isNotNull);
      expect(captured!.isNotEmpty, isTrue);
    });
  });

  group('event ordering', () {
    test('AgentStart before TurnStart before TurnEnd before AgentEnd',
        () async {
      final events = await agentLoop(
        _testContext(),
        _testConfig(),
      ).toList();

      final startIndex = events.indexWhere((e) => e is AgentStart);
      final turnStartIndex = events.indexWhere((e) => e is TurnStart);
      final turnEndIndex = events.indexWhere((e) => e is TurnEnd);
      final endIndex = events.indexWhere((e) => e is AgentEnd);

      expect(startIndex, lessThan(turnStartIndex));
      expect(turnStartIndex, lessThan(turnEndIndex));
      expect(turnEndIndex, lessThan(endIndex));
    });
  });
}
