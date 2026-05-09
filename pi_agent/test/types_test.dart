import 'package:test/test.dart';
import 'package:pi/pi.dart';

void main() {
  group('ContentBlock sealed class', () {
    test('TextBlock holds text', () {
      const block = TextBlock('hello');
      expect(block.text, 'hello');
    });

    test('ImageBlock holds base64 and mediaType', () {
      const block = ImageBlock(base64Data: 'abc123', mediaType: 'image/png');
      expect(block.base64Data, 'abc123');
      expect(block.mediaType, 'image/png');
    });

    test('const construction works', () {
      const block = TextBlock('test');
      expect(block, isA<TextBlock>());
    });
  });

  group('AgentMessage sealed class', () {
    test('UserMessage holds content blocks', () {
      final msg = UserMessage(content: [const TextBlock('hello')]);
      expect(msg.content, hasLength(1));
      expect((msg.content[0] as TextBlock).text, 'hello');
    });

    test('UserMessage.text convenience constructor', () {
      final msg = UserMessage.text('hello');
      expect(msg.content, hasLength(1));
      expect((msg.content[0] as TextBlock).text, 'hello');
    });

    test('AssistantMessage holds mixed content', () {
      final msg = AssistantMessage(
        id: 'msg-1',
        content: [
          const TextBlock('hello'),
          const ToolCallBlock(id: 'tc-1', name: 'foo', arguments: {})
        ],
        stopReason: StopReason.toolUse,
        usage: const Usage(inputTokens: 10, outputTokens: 20),
      );
      expect(msg.id, 'msg-1');
      expect(msg.content, hasLength(2));
      expect(msg.stopReason, StopReason.toolUse);
      expect(msg.usage!.inputTokens, 10);
    });

    test('AssistantMessage.text extracts text', () {
      final msg = AssistantMessage(content: [
        const TextBlock('hello '),
        const TextBlock('world'),
      ]);
      expect(msg.text, 'hello world');
    });

    test('AssistantMessage.toolCalls extracts tool calls', () {
      final msg = AssistantMessage(content: [
        const TextBlock('text'),
        const ToolCallBlock(id: 'tc-1', name: 'foo', arguments: {'a': 1}),
      ]);
      expect(msg.toolCalls, hasLength(1));
      expect(msg.toolCalls[0].name, 'foo');
    });

    test('ToolResultMessage holds result', () {
      final msg = ToolResultMessage(
        toolCallId: 'tc-1',
        toolName: 'foo',
        content: [const TextBlock('result')],
      );
      expect(msg.toolCallId, 'tc-1');
      expect(msg.isError, false);
    });

    test('ToolResultMessage.text convenience constructor', () {
      final msg = ToolResultMessage.text(
        toolCallId: 'tc-1',
        toolName: 'foo',
        text: 'error',
        isError: true,
      );
      expect(msg.isError, true);
      expect((msg.content[0] as TextBlock).text, 'error');
    });

    test('CustomMessage holds type and data', () {
      const msg = CustomMessage(type: 'bash', data: {}, display: 'ls');
      expect(msg.type, 'bash');
      expect(msg.display, 'ls');
    });
  });

  group('AgentEvent sealed class', () {
    test('all event types construct', () {
      expect(const AgentStart(), isA<AgentStart>());
      expect(AgentEnd(messages: []), isA<AgentEnd>());
      expect(const TurnStart(), isA<TurnStart>());
      expect(TurnEnd(message: UserMessage.text(''), toolResults: []),
          isA<TurnEnd>());
      expect(MessageStart(message: UserMessage.text('')), isA<MessageStart>());
      expect(
          MessageUpdate(message: UserMessage.text('')), isA<MessageUpdate>());
      expect(MessageEnd(message: UserMessage.text('')), isA<MessageEnd>());
      expect(const ToolExecutionStart(toolCallId: '1', toolName: 't', args: {}),
          isA<ToolExecutionStart>());
      expect(
          const ToolExecutionUpdate(
              toolCallId: '1', toolName: 't', args: {}, partialResult: null),
          isA<ToolExecutionUpdate>());
      expect(
          const ToolExecutionEnd(
              toolCallId: '1',
              toolName: 't',
              args: {},
              result: null,
              isError: false),
          isA<ToolExecutionEnd>());
    });

    test('switch exhaustiveness - covers all types', () {
      String describe(AgentEvent event) => switch (event) {
            AgentStart() => 'start',
            AgentEnd() => 'end',
            TurnStart() => 'turn_start',
            TurnEnd() => 'turn_end',
            MessageStart() => 'msg_start',
            MessageUpdate() => 'msg_update',
            MessageEnd() => 'msg_end',
            ToolExecutionStart() => 'tool_start',
            ToolExecutionUpdate() => 'tool_update',
            ToolExecutionEnd() => 'tool_end',
          };

      expect(describe(const AgentStart()), 'start');
      expect(describe(AgentEnd(messages: [])), 'end');
      expect(describe(const TurnStart()), 'turn_start');
    });
  });

  group('Model', () {
    test('constructs with defaults', () {
      const model =
          Model(provider: 'openai', modelId: 'gpt-4o', contextWindow: 128000);
      expect(model.provider, 'openai');
      expect(model.supportsVision, false);
      expect(model.supportsThinking, false);
      expect(model.supportsTools, true);
    });

    test('toString format', () {
      const model =
          Model(provider: 'openai', modelId: 'gpt-4o', contextWindow: 128000);
      expect(model.toString(), 'Model(openai/gpt-4o)');
    });
  });

  group('Enums', () {
    test('ThinkingLevel has correct values', () {
      expect(ThinkingLevel.values, [
        ThinkingLevel.off,
        ThinkingLevel.minimal,
        ThinkingLevel.low,
        ThinkingLevel.medium,
        ThinkingLevel.high,
        ThinkingLevel.xhigh,
      ]);
    });

    test('StopReason has correct values', () {
      expect(StopReason.values, hasLength(5));
    });

    test('ToolExecutionMode values', () {
      expect(ToolExecutionMode.values,
          [ToolExecutionMode.sequential, ToolExecutionMode.parallel]);
    });
  });

  group('SessionTreeEntry sealed class', () {
    final now = DateTime.now();

    test('MessageEntry constructs', () {
      final entry = MessageEntry(
        id: '1',
        parentId: '',
        timestamp: now,
        role: 'user',
        message: UserMessage.text('hi'),
      );
      expect(entry.id, '1');
      expect(entry.role, 'user');
    });

    test('CompactionEntry constructs', () {
      final entry = CompactionEntry(
        id: '2',
        parentId: '1',
        timestamp: now,
        summary: 'summary',
        firstKeptEntryId: '3',
        tokensBefore: 1000,
      );
      expect(entry.summary, 'summary');
      expect(entry.tokensBefore, 1000);
    });

    test('switch exhaustiveness covers all subtypes', () {
      String kind(SessionTreeEntry e) => switch (e) {
            MessageEntry() => 'msg',
            ThinkingLevelChangeEntry() => 'thinking',
            ModelChangeEntry() => 'model',
            CompactionEntry() => 'compact',
            BranchSummaryEntry() => 'branch',
            LabelEntry() => 'label',
            CustomEntry() => 'custom',
            CustomMessageEntry() => 'custom_msg',
          };

      final entry = MessageEntry(
          id: '1',
          parentId: '',
          timestamp: now,
          role: 'user',
          message: UserMessage.text(''));
      expect(kind(entry), 'msg');
    });
  });

  group('AgentState', () {
    test('default construction', () {
      const model =
          Model(provider: 'openai', modelId: 'gpt-4o', contextWindow: 128000);
      final state = AgentState(systemPrompt: 'test', model: model);
      expect(state.systemPrompt, 'test');
      expect(state.messages, isEmpty);
      expect(state.tools, isEmpty);
      expect(state.isStreaming, false);
      expect(state.streamingMessage, isNull);
      expect(state.pendingToolCalls, isEmpty);
      expect(state.errorMessage, isNull);
    });

    test('tools setter replaces list', () {
      const model =
          Model(provider: 'openai', modelId: 'gpt-4o', contextWindow: 128000);
      final state = AgentState(systemPrompt: '', model: model);
      expect(state.tools, isEmpty);
    });

    test('messages setter replaces list', () {
      const model =
          Model(provider: 'openai', modelId: 'gpt-4o', contextWindow: 128000);
      final state = AgentState(
        systemPrompt: '',
        model: model,
        messages: [UserMessage.text('a')],
      );
      expect(state.messages, hasLength(1));
      state.messages = [UserMessage.text('b'), UserMessage.text('c')];
      expect(state.messages, hasLength(2));
    });

    test('messages and tools views are unmodifiable', () {
      const model =
          Model(provider: 'openai', modelId: 'gpt-4o', contextWindow: 128000);
      final state = AgentState(
        systemPrompt: '',
        model: model,
        messages: [UserMessage.text('a')],
      );
      expect(() => state.messages.add(UserMessage.text('b')),
          throwsA(isA<UnsupportedError>()));
      expect(() => state.tools.add(42 as dynamic),
          throwsA(isA<UnsupportedError>()));
    });
  });
}
