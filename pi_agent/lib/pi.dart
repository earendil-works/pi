/// Dart agent framework for building AI-powered applications.
///
/// This package provides an [Agent] class with streaming event emission,
/// tool execution, session persistence, and LLM provider integration.
///
/// ```dart
/// import 'package:pi/pi.dart';
///
/// void main() async {
///   final agent = Agent(
///     model: Model(provider: 'openai', modelId: 'gpt-4o', contextWindow: 128000),
///     systemPrompt: 'You are a helpful assistant.',
///     getApiKey: (provider) async => Platform.environment['OPENAI_API_KEY'],
///   );
///   await agent.prompt('Hello!');
/// }
/// ```
library;

export 'src/types.dart' hide AgentTool;
export 'src/agent.dart';
export 'src/agent_loop.dart';
export 'src/tools.dart';
export 'src/session.dart';
export 'src/session_storage.dart';
export 'src/skills.dart';
export 'src/prompt_templates.dart';
export 'src/execution_env.dart';
export 'src/compaction.dart';
export 'src/sse_parser.dart';
export 'src/llm_client.dart';
export 'src/conversion.dart';
