/// Example demonstrating pi_agent usage.
///
/// Run with: dart run example/main.dart
library;

import 'dart:io';

import 'package:pi/pi.dart';

void main() async {
  final apiKey = Platform.environment['OPENAI_API_KEY'];
  if (apiKey == null) {
    stderr.writeln('Set OPENAI_API_KEY environment variable.');
    exit(1);
  }

  final agent = Agent(
    model: const Model(
      provider: 'openai',
      modelId: 'gpt-4o',
      contextWindow: 128000,
    ),
    systemPrompt: 'You are a helpful assistant. Be concise.',
    getApiKey: (provider) async => apiKey,
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
        print('\n');
      default:
        break;
    }
  });

  await agent.prompt('What is the capital of France?');

  // Continue the conversation
  await agent.continue_();
}
