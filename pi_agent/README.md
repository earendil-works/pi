# pi_agent

A Dart agent framework for building AI-powered applications with tool execution, streaming events, and session persistence.

## Features

- **Agent Loop**: Start conversations, continue from context, stream responses in real-time
- **Tool Execution**: Define tools with typed parameter schemas, parallel or sequential execution
- **Streaming Events**: Subscribe to typed lifecycle events (message streaming, tool calls, etc.)
- **Session Persistence**: Tree-of-entries conversation storage with branching support
- **Skills**: Load reusable agent behaviors from SKILL.md files
- **Prompt Templates**: Parameterized prompts with argument substitution
- **Context Compaction**: Automatic summarization to stay within context limits
- **LLM Providers**: OpenAI-compatible and Anthropic streaming API support

## Installation

```yaml
dependencies:
  pi_agent: ^0.1.0
```

## Quick Start

```dart
import 'package:pi/pi.dart';

void main() async {
  final agent = Agent(
    model: Model(
      provider: 'openai',
      modelId: 'gpt-4o',
      contextWindow: 128000,
    ),
    systemPrompt: 'You are a helpful assistant.',
    getApiKey: (provider) async => Platform.environment['OPENAI_API_KEY'],
  );

  agent.subscribe((event) {
    switch (event) {
      case MessageUpdate(message: final msg):
        if (msg is AssistantMessage) {
          for (final block in msg.content) {
            if (block is TextBlock) stdout.write(block.text);
          }
        }
      case AgentEnd():
        print('\nDone.');
      default:
        break;
    }
  });

  await agent.prompt('Hello!');
}
```

## License

BSD 3-Clause. See [LICENSE](LICENSE).
