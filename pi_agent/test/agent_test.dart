import 'dart:async';

import 'package:test/test.dart';
import 'package:pi/src/types.dart' hide AgentTool;
import 'package:pi/src/tools.dart';
import 'package:pi/src/agent.dart';

void main() {
  group('Agent construction', () {
    test('creates with defaults', () {
      final agent = Agent();
      expect(agent.isRunning, isFalse);
      expect(agent.sessionId, isNull);
      expect(agent.state.messages, isEmpty);
      expect(agent.state.tools, isEmpty);
      expect(agent.state.isStreaming, isFalse);
      expect(agent.state.streamingMessage, isNull);
      expect(agent.state.errorMessage, isNull);
    });

    test('creates with individual params', () {
      final model = const Model(
          provider: 'anthropic',
          modelId: 'claude-3',
          contextWindow: 200000);
      final agent = Agent(
        model: model,
        systemPrompt: 'You are helpful.',
        sessionId: 'sess-1',
      );
      expect(agent.state.model.modelId, 'claude-3');
      expect(agent.state.systemPrompt, 'You are helpful.');
      expect(agent.sessionId, 'sess-1');
    });

    test('creates with AgentOptions', () {
      final agent = Agent(
        options: AgentOptions(
          model: const Model(
              provider: 'openai', modelId: 'gpt-4', contextWindow: 128000),
          systemPrompt: 'test prompt',
          sessionId: 'sess-opts',
        ),
      );
      expect(agent.state.model.modelId, 'gpt-4');
      expect(agent.state.systemPrompt, 'test prompt');
      expect(agent.sessionId, 'sess-opts');
    });

    test('AgentOptions takes precedence over individual params', () {
      final agent = Agent(
        model: const Model(
            provider: 'openai', modelId: 'gpt-3', contextWindow: 4000),
        options: AgentOptions(
          model: const Model(
              provider: 'anthropic', modelId: 'claude-3', contextWindow: 200000),
        ),
      );
      expect(agent.state.model.modelId, 'claude-3');
    });

    test('creates with initial messages', () {
      final agent = Agent(
        messages: [UserMessage.text('hello')],
      );
      expect(agent.state.messages, hasLength(1));
    });

    test('creates with initial tools', () {
      final agent = Agent(
        tools: [
          AgentTool(
            name: 'read',
            description: 'Read file',
            parameters: {},
            execute: (id, params, {onUpdate, isAborted}) async =>
                AgentToolResult(
                    content: [const TextBlock('ok')], details: null),
          ),
        ],
      );
      expect(agent.state.tools, hasLength(1));
    });
  });

  group('Agent prompt', () {
    test('accepts string input', () async {
      final events = <AgentEvent>[];
      final agent = Agent(
        streamFn: (ctx, config) => Stream.fromIterable([
          MessageEnd(
            message: AssistantMessage(content: [const TextBlock('response')]),
          ),
        ]),
      );
      agent.subscribe((e) => events.add(e));
      await agent.prompt('hello');
      expect(events, isNotEmpty);
      expect(events.first, isA<AgentStart>());
      expect(events.last, isA<AgentEnd>());
      expect(agent.state.messages, hasLength(2));
    });

    test('accepts List<ContentBlock>', () async {
      final agent = Agent(
        streamFn: (ctx, config) => Stream.fromIterable([
          MessageEnd(
            message: AssistantMessage(content: [const TextBlock('hi')]),
          ),
        ]),
      );
      await agent.prompt([const TextBlock('hello')]);
      expect(agent.state.messages, hasLength(2));
      expect(agent.state.messages.first, isA<UserMessage>());
    });

    test('accepts AgentMessage', () async {
      final agent = Agent(
        streamFn: (ctx, config) => Stream.empty(),
      );
      await agent.prompt(UserMessage.text('hi'));
      expect(agent.state.messages, hasLength(1));
    });

    test('accepts List<AgentMessage>', () async {
      final agent = Agent(
        streamFn: (ctx, config) => Stream.empty(),
      );
      await agent.prompt([UserMessage.text('a'), UserMessage.text('b')]);
      expect(agent.state.messages, hasLength(2));
    });

    test('throws on unsupported input type', () {
      final agent = Agent();
      expect(() => agent.prompt(42), throwsArgumentError);
    });
  });

  group('Agent concurrent rejection', () {
    test('prompt rejects when already running', () async {
      final controller = StreamController<AgentEvent>();
      final agent = Agent(
        streamFn: (ctx, config) => controller.stream,
      );

      final completer = Completer<void>();
      agent.subscribe((e) {
        if (e is AgentEnd && !completer.isCompleted) completer.complete();
      });

      agent.prompt('first');

      await Future<void>.delayed(const Duration(milliseconds: 5));

      expect(() => agent.prompt('second'), throwsStateError);

      controller.add(MessageEnd(
        message: AssistantMessage(content: [const TextBlock('done')]),
      ));
      await controller.close();
      await completer.future;
    });

    test('continue_ rejects when already running', () async {
      final controller = StreamController<AgentEvent>();
      final agent = Agent(
        messages: [UserMessage.text('exists')],
        streamFn: (ctx, config) => controller.stream,
      );

      final completer = Completer<void>();
      agent.subscribe((e) {
        if (e is AgentEnd && !completer.isCompleted) completer.complete();
      });

      agent.prompt('first');

      await Future<void>.delayed(const Duration(milliseconds: 5));

      expect(() => agent.continue_(), throwsStateError);

      controller.add(MessageEnd(
        message: AssistantMessage(content: [const TextBlock('done')]),
      ));
      await controller.close();
      await completer.future;
    });
  });

  group('Agent continue_', () {
    test('throws on empty transcript', () {
      final agent = Agent();
      expect(() => agent.continue_(), throwsStateError);
    });

    test('continues from existing messages', () async {
      final events = <AgentEvent>[];
      final agent = Agent(
        messages: [UserMessage.text('hello')],
        streamFn: (ctx, config) => Stream.fromIterable([
          MessageEnd(
            message: AssistantMessage(content: [const TextBlock('world')]),
          ),
        ]),
      );
      agent.subscribe((e) => events.add(e));
      await agent.continue_();
      expect(events.any((e) => e is AgentStart), isTrue);
      expect(agent.state.messages, hasLength(2));
    });
  });

  group('Agent event subscription', () {
    test('subscribe receives events', () async {
      final events = <AgentEvent>[];
      final agent = Agent(
        streamFn: (ctx, config) => Stream.fromIterable([
          MessageEnd(
            message: AssistantMessage(content: [const TextBlock('hi')]),
          ),
        ]),
      );
      agent.subscribe((e) => events.add(e));
      await agent.prompt('test');
      expect(events, isNotEmpty);
    });

    test('unsubscribe stops receiving events', () async {
      final events = <AgentEvent>[];
      final agent = Agent(
        streamFn: (ctx, config) => Stream.fromIterable([
          MessageEnd(
            message: AssistantMessage(content: [const TextBlock('hi')]),
          ),
        ]),
      );
      final unsub = agent.subscribe((e) => events.add(e));
      unsub();

      await agent.prompt('test');
      expect(events, isEmpty);
    });

    test('multiple listeners all receive events', () async {
      final events1 = <AgentEvent>[];
      final events2 = <AgentEvent>[];
      final agent = Agent(
        streamFn: (ctx, config) => Stream.fromIterable([
          MessageEnd(
            message: AssistantMessage(content: [const TextBlock('hi')]),
          ),
        ]),
      );
      agent.subscribe((e) => events1.add(e));
      agent.subscribe((e) => events2.add(e));
      await agent.prompt('test');
      expect(events1, isNotEmpty);
      expect(events2, isNotEmpty);
      expect(events1.length, events2.length);
    });
  });

  group('Agent abort', () {
    test('abort stops event processing', () async {
      final events = <AgentEvent>[];
      final controller = StreamController<AgentEvent>();

      final agent = Agent(
        streamFn: (ctx, config) => controller.stream,
      );
      agent.subscribe((e) => events.add(e));

      controller.add(MessageEnd(
        message: AssistantMessage(content: [const TextBlock('first')]),
      ));

      await Future<void>.delayed(const Duration(milliseconds: 5));

      agent.abort();

      controller.add(MessageEnd(
        message: AssistantMessage(content: [const TextBlock('second')]),
      ));

      await controller.close();
      await agent.waitForIdle();

      expect(events.whereType<MessageEnd>(), hasLength(1));
    });
  });

  group('Agent reset', () {
    test('clears messages and state', () async {
      final agent = Agent(
        streamFn: (ctx, config) => Stream.fromIterable([
          MessageEnd(
            message: AssistantMessage(content: [const TextBlock('hi')]),
          ),
        ]),
      );
      await agent.prompt('hello');
      expect(agent.state.messages, isNotEmpty);

      agent.reset();
      expect(agent.state.messages, isEmpty);
      expect(agent.state.errorMessage, isNull);
      expect(agent.state.isStreaming, isFalse);
      expect(agent.state.streamingMessage, isNull);
      expect(agent.state.pendingToolCalls, isEmpty);
    });

    test('clears queues', () async {
      final agent = Agent();
      agent.steer(UserMessage.text('steer'));
      agent.followUp(UserMessage.text('follow'));
      expect(agent.hasQueuedMessages(), isTrue);

      agent.reset();
      expect(agent.hasQueuedMessages(), isFalse);
    });
  });

  group('Agent steering and follow-up', () {
    test('steer queues message', () {
      final agent = Agent();
      agent.steer(UserMessage.text('correction'));
      expect(agent.hasQueuedMessages(), isTrue);
    });

    test('followUp queues message', () {
      final agent = Agent();
      agent.followUp(UserMessage.text('next'));
      expect(agent.hasQueuedMessages(), isTrue);
    });

    test('clearSteeringQueue works', () {
      final agent = Agent();
      agent.steer(UserMessage.text('a'));
      agent.followUp(UserMessage.text('b'));
      agent.clearSteeringQueue();
      expect(agent.hasQueuedMessages(), isTrue);
    });

    test('clearFollowUpQueue works', () {
      final agent = Agent();
      agent.steer(UserMessage.text('a'));
      agent.followUp(UserMessage.text('b'));
      agent.clearFollowUpQueue();
      expect(agent.hasQueuedMessages(), isTrue);
    });

    test('clearAllQueues works', () {
      final agent = Agent();
      agent.steer(UserMessage.text('a'));
      agent.followUp(UserMessage.text('b'));
      agent.clearAllQueues();
      expect(agent.hasQueuedMessages(), isFalse);
    });
  });

  group('Agent event handling', () {
    test('MessageStart sets streamingMessage', () async {
      final agent = Agent(
        streamFn: (ctx, config) => Stream.fromIterable([
          MessageStart(
            message: AssistantMessage(content: [const TextBlock('')]),
          ),
          MessageEnd(
            message: AssistantMessage(content: [const TextBlock('hi')]),
          ),
        ]),
      );

      AgentMessage? captured;
      agent.subscribe((e) {
        if (e is MessageStart) captured = e.message;
      });

      await agent.prompt('test');
      expect(captured, isNotNull);
    });

    test('MessageEnd adds to messages', () async {
      final agent = Agent(
        streamFn: (ctx, config) => Stream.fromIterable([
          MessageEnd(
            message: AssistantMessage(content: [const TextBlock('done')]),
          ),
        ]),
      );
      await agent.prompt('test');
      expect(
        agent.state.messages.last,
        isA<AssistantMessage>(),
      );
    });

    test('ToolExecutionStart/End tracks pending calls', () async {
      final agent = Agent(
        streamFn: (ctx, config) => Stream.fromIterable([
          const ToolExecutionStart(
            toolCallId: 'tc1',
            toolName: 'read',
            args: {},
          ),
          const ToolExecutionEnd(
            toolCallId: 'tc1',
            toolName: 'read',
            args: {},
            result: 'ok',
            isError: false,
          ),
          MessageEnd(
            message: AssistantMessage(content: [const TextBlock('done')]),
          ),
        ]),
      );

      final pendingIds = <String>{};
      agent.subscribe((e) {
        if (e is ToolExecutionStart) {
          pendingIds.add(e.toolCallId);
        }
      });

      await agent.prompt('test');
      expect(pendingIds, contains('tc1'));
      expect(agent.state.pendingToolCalls, isEmpty);
    });
  });

  group('Agent error handling', () {
    test('stream error sets errorMessage', () async {
      final agent = Agent(
        streamFn: (ctx, config) => Stream.error(Exception('boom')),
      );
      await agent.prompt('test');
      expect(agent.state.errorMessage, contains('boom'));
    });

    test('agent is not running after error', () async {
      final agent = Agent(
        streamFn: (ctx, config) => Stream.error(Exception('fail')),
      );
      await agent.prompt('test');
      expect(agent.isRunning, isFalse);
      expect(agent.state.isStreaming, isFalse);
    });
  });

  group('Agent setters', () {
    test('toolExecution setter', () {
      final agent = Agent();
      agent.toolExecution = ToolExecutionMode.sequential;
    });

    test('steeringMode setter', () {
      final agent = Agent();
      agent.steeringMode = SteeringMode.all;
    });

    test('followUpMode setter', () {
      final agent = Agent();
      agent.followUpMode = FollowUpMode.all;
    });

    test('convertToLlm setter', () {
      final agent = Agent();
      agent.convertToLlm = (msgs) async => [];
    });

    test('transformContext setter', () {
      final agent = Agent();
      agent.transformContext = (msgs, {isAborted}) async => msgs;
    });

    test('streamFn setter', () {
      final agent = Agent();
      agent.streamFn = (ctx, config) => Stream.empty();
    });

    test('getApiKey setter', () {
      final agent = Agent();
      agent.getApiKey = (provider) async => 'key';
    });

    test('beforeToolCall setter', () {
      final agent = Agent();
      agent.beforeToolCall = (ctx, {isAborted}) async => null;
    });

    test('afterToolCall setter', () {
      final agent = Agent();
      agent.afterToolCall = (ctx, {isAborted}) async => null;
    });
  });
}
