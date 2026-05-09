# Quickstart: pi_agent

## Installation

```bash
dart pub add pi_agent
```

Or add to `pubspec.yaml`:

```yaml
dependencies:
  pi_agent: ^0.1.0
```

## Minimal Example

```dart
import 'package:pi/pi.dart';

void main() async {
  // 1. Create an agent
  final agent = Agent(
    model: Model(provider: 'openai', modelId: 'gpt-4o', contextWindow: 128000),
    systemPrompt: 'You are a helpful assistant.',
    getApiKey: (provider) async => Platform.environment['OPENAI_API_KEY'],
  );

  // 2. Subscribe to events
  agent.subscribe((event) {
    switch (event) {
      case MessageUpdate(message: final msg):
        if (msg is AssistantMessage) {
          for (final block in msg.content) {
            if (block is TextBlock) stdout.write(block.text);
          }
        }
      case AgentEnd(messages: final msgs):
        print('\nAgent finished.');
      default:
        break;
    }
  });

  // 3. Send a prompt
  await agent.prompt('What is the capital of France?');
}
```

## Adding Tools

```dart
final weatherTool = AgentTool<String, String>(
  name: 'get_weather',
  description: 'Get the current weather for a city',
  parameters: {
    'type': 'object',
    'properties': {
      'city': {'type': 'string', 'description': 'City name'}
    },
    'required': ['city'],
  },
  label: 'Get Weather',
  execute: (toolCallId, params, {onUpdate, isAborted}) async {
    final city = params['city'] as String;
    // Call weather API...
    return AgentToolResult(
      content: [TextBlock('Sunny in $city, 72°F')],
      details: 'Sunny, 72°F',
    );
  },
);

final agent = Agent(
  model: Model(provider: 'openai', modelId: 'gpt-4o', contextWindow: 128000),
  systemPrompt: 'You are a helpful assistant.',
  tools: [weatherTool],
  getApiKey: (provider) async => Platform.environment['OPENAI_API_KEY'],
);

await agent.prompt('What\'s the weather in London?');
```

## Continuing Conversations

```dart
await agent.prompt('Hello!');
// ... agent responds ...

await agent.continue_(); // Continue the conversation
```

## Session Persistence

```dart
final storage = JsonlSessionStorage('session.jsonl');
final session = Session(storage);

// As messages come in, append them
agent.subscribe((event) {
  // Append completed messages to session
});

// Later, reconstruct
final session2 = Session(JsonlSessionStorage('session.jsonl'));
final context = await session2.buildContext();
// context.messages contains the full history
```

## Loading Skills

```dart
final skills = await loadSkills(['./skills']);
final skillsXml = formatSkillsForSystemPrompt(skills);

final agent = Agent(
  model: Model(provider: 'openai', modelId: 'gpt-4o', contextWindow: 128000),
  systemPrompt: 'You have these skills:\n$skillsXml',
  tools: myTools,
  getApiKey: (provider) async => Platform.environment['OPENAI_API_KEY'],
);
```

## Provider Configuration

```dart
// OpenAI
Agent(
  model: Model(provider: 'openai', modelId: 'gpt-4o', contextWindow: 128000),
  getApiKey: (provider) async => Platform.environment['OPENAI_API_KEY'],
)

// Anthropic
Agent(
  model: Model(provider: 'anthropic', modelId: 'claude-sonnet-4-20250514', contextWindow: 200000),
  getApiKey: (provider) async => Platform.environment['ANTHROPIC_API_KEY'],
)

// Any OpenAI-compatible provider (Ollama, Groq, etc.)
Agent(
  model: Model(provider: 'openai', modelId: 'llama3', contextWindow: 32000),
  getApiKey: (provider) async => null, // No key needed for local
)
```

## Abort Handling

```dart
final agent = Agent(
  model: myModel,
  systemPrompt: '...',
  getApiKey: myKeyResolver,
);

// Start a prompt (non-awaited if you want to abort)
final future = agent.prompt('Write a long essay...');

// Abort after 5 seconds
Future.delayed(Duration(seconds: 5), () => agent.abort());

await future; // Will complete after abort cleanup
```
