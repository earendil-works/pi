# @kennyfrc/mu-ai

Unified LLM API with automatic model discovery, provider configuration, token and cost tracking, and simple context persistence and hand-off to other models mid-session.

**Note**: This library only includes models that support tool calling (function calling), as this is essential for agentic workflows.

## Supported Providers

- **OpenAI**
- **Anthropic**
- **Google**
- **Groq**
- **Cerebras**
- **xAI**
- **OpenRouter**
- **Moonshot (Kimi)**
- **Any OpenAI-compatible API**: Ollama, vLLM, LM Studio, etc.

## Installation

```bash
npm install @kennyfrc/mu-ai
```

## Quick Start

```typescript
import { Type, getModel, stream, complete, Context, Tool, StringEnum } from '@kennyfrc/mu-ai';

// Fully typed with auto-complete support for both providers and models
const model = getModel('openai', 'gpt-4o-mini');

// Define tools with TypeBox schemas for type safety and validation
const tools: Tool[] = [{
  name: 'get_time',
  description: 'Get the current time',
  parameters: Type.Object({
    timezone: Type.Optional(Type.String({ description: 'Optional timezone (e.g., America/New_York)' }))
  })
}];

// Build a conversation context (easily serializable and transferable between models)
const context: Context = {
  systemPrompt: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'What time is it?' }],
  tools
};

// Option 1: Streaming with all event types
const s = stream(model, context);

for await (const event of s) {
  switch (event.type) {
    case 'start':
      console.log(`Starting with ${event.partial.model}`);
      break;
    case 'text_start':
      console.log('\n[Text started]');
      break;
    case 'text_delta':
      process.stdout.write(event.delta);
      break;
    case 'text_end':
      console.log('\n[Text ended]');
      break;
    case 'thinking_start':
      console.log('[Model is thinking...]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);
      break;
    case 'thinking_end':
      console.log('[Thinking complete]');
      break;
    case 'toolcall_start':
      console.log(`\n[Tool call started: index ${event.contentIndex}]`);
      break;
    case 'toolcall_delta':
      // Partial tool arguments are being streamed
      const partialCall = event.partial.content[event.contentIndex];
      if (partialCall.type === 'toolCall') {
        console.log(`[Streaming args for ${partialCall.name}]`);
      }
      break;
    case 'toolcall_end':
      console.log(`\nTool called: ${event.toolCall.name}`);
      console.log(`Arguments: ${JSON.stringify(event.toolCall.arguments)}`);
      break;
    case 'done':
      console.log(`\nFinished: ${event.reason}`);
      break;
    case 'error':
      console.error(`Error: ${event.error}`);
      break;
  }
}

// Get the final message after streaming, add it to the context
const finalMessage = await s.result();
context.messages.push(finalMessage);

// Handle tool calls if any
const toolCalls = finalMessage.content.filter(b => b.type === 'toolCall');
for (const call of toolCalls) {
  // Execute the tool
  const result = call.name === 'get_time'
    ? new Date().toLocaleString('en-US', {
        timeZone: call.arguments.timezone || 'UTC',
        dateStyle: 'full',
        timeStyle: 'long'
      })
    : 'Unknown tool';

  // Add tool result to context (supports text and images)
  context.messages.push({
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: result }],
    isError: false,
    timestamp: Date.now()
  });
}

// Continue if there were tool calls
if (toolCalls.length > 0) {
  const continuation = await complete(model, context);
  context.messages.push(continuation);
  console.log('After tool execution:', continuation.content);
}

console.log(`Total tokens: ${finalMessage.usage.input} in, ${finalMessage.usage.output} out`);
console.log(`Cost: $${finalMessage.usage.cost.total.toFixed(4)}`);

// Option 2: Get complete response without streaming
const response = await complete(model, context);

for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  } else if (block.type === 'toolCall') {
    console.log(`Tool: ${block.name}(${JSON.stringify(block.arguments)})`);
  }
}
```

## Tools

Tools enable LLMs to interact with external systems. This library uses TypeBox schemas for type-safe tool definitions with automatic validation using AJV. TypeBox schemas can be serialized and deserialized as plain JSON, making them ideal for distributed systems.

### Defining Tools

```typescript
import { Type, Tool, StringEnum } from '@kennyfrc/mu-ai';

// Define tool parameters with TypeBox
const weatherTool: Tool = {
  name: 'get_weather',
  description: 'Get current weather for a location',
  parameters: Type.Object({
    location: Type.String({ description: 'City name or coordinates' }),
    units: StringEnum(['celsius', 'fahrenheit'], { default: 'celsius' })
  })
};

// Note: For Google API compatibility, use StringEnum helper instead of Type.Enum
// Type.Enum generates anyOf/const patterns that Google doesn't support

const bookMeetingTool: Tool = {
  name: 'book_meeting',
  description: 'Schedule a meeting',
  parameters: Type.Object({
    title: Type.String({ minLength: 1 }),
    startTime: Type.String({ format: 'date-time' }),
    endTime: Type.String({ format: 'date-time' }),
    attendees: Type.Array(Type.String({ format: 'email' }), { minItems: 1 })
  })
};
```

### Handling Tool Calls

Tool results use content blocks and can include both text and images:

```typescript
import { readFileSync } from 'fs';

const context: Context = {
  messages: [{ role: 'user', content: 'What is the weather in London?' }],
  tools: [weatherTool]
};

const response = await complete(model, context);

// Check for tool calls in the response
for (const block of response.content) {
  if (block.type === 'toolCall') {
    // Arguments are automatically validated against the TypeBox schema using AJV
    // If validation fails, an error event is emitted
    const result = await executeWeatherApi(block.arguments);

    // Add tool result with text content
    context.messages.push({
      role: 'toolResult',
      toolCallId: block.id,
      toolName: block.name,
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: false,
      timestamp: Date.now()
    });
  }
}

// Tool results can also include images (for vision-capable models)
const imageBuffer = readFileSync('chart.png');
context.messages.push({
  role: 'toolResult',
  toolCallId: 'tool_xyz',
  toolName: 'generate_chart',
  content: [
    { type: 'text', text: 'Generated chart showing temperature trends' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ],
  isError: false,
  timestamp: Date.now()
});
```

### Streaming Tool Calls with Partial JSON

During streaming, tool call arguments are progressively parsed as they arrive. This enables real-time UI updates before the complete arguments are available:

```typescript
const s = stream(model, context);

for await (const event of s) {
  if (event.type === 'toolcall_delta') {
    const toolCall = event.partial.content[event.contentIndex];

    // toolCall.arguments contains partially parsed JSON during streaming
    // This allows for progressive UI updates
    if (toolCall.type === 'toolCall' && toolCall.arguments) {
      // BE DEFENSIVE: arguments may be incomplete
      // Example: Show file path being written even before content is complete
      if (toolCall.name === 'write_file' && toolCall.arguments.path) {
        console.log(`Writing to: ${toolCall.arguments.path}`);

        // Content might be partial or missing
        if (toolCall.arguments.content) {
          console.log(`Content preview: ${toolCall.arguments.content.substring(0, 100)}...`);
        }
      }
    }
  }

  if (event.type === 'toolcall_end') {
    // Here toolCall.arguments is complete and validated
    const toolCall = event.toolCall;
    console.log(`Tool completed: ${toolCall.name}`, toolCall.arguments);
  }
}
```

**Important notes about partial tool arguments:**
- During `toolcall_delta` events, `arguments` contains the best-effort parse of partial JSON
- Fields may be missing or incomplete - always check for existence before use
- String values may be truncated mid-word
- Arrays may be incomplete
- Nested objects may be partially populated
- At minimum, `arguments` will be an empty object `{}`, never `undefined`
- Full validation only occurs at `toolcall_end` when arguments are complete
- The Google provider does not support function call streaming. Instead, you will receive a single `toolcall_delta` event with the full arguments.

### Complete Event Reference

All streaming events emitted during assistant message generation:

| Event Type | Description | Key Properties |
|------------|-------------|----------------|
| `start` | Stream begins | `partial`: Initial assistant message structure |
| `text_start` | Text block starts | `contentIndex`: Position in content array |
| `text_delta` | Text chunk received | `delta`: New text, `contentIndex`: Position |
| `text_end` | Text block complete | `content`: Full text, `contentIndex`: Position |
| `thinking_start` | Thinking block starts | `contentIndex`: Position in content array |
| `thinking_delta` | Thinking chunk received | `delta`: New text, `contentIndex`: Position |
| `thinking_end` | Thinking block complete | `content`: Full thinking, `contentIndex`: Position |
| `toolcall_start` | Tool call begins | `contentIndex`: Position in content array |
| `toolcall_delta` | Tool arguments streaming | `delta`: JSON chunk, `partial.content[contentIndex].arguments`: Partial parsed args |
| `toolcall_end` | Tool call complete | `toolCall`: Complete validated tool call with `id`, `name`, `arguments` |
| `done` | Stream complete | `reason`: Stop reason ("stop", "length", "toolUse"), `message`: Final assistant message |
| `error` | Error occurred | `reason`: Error type ("error" or "aborted"), `error`: AssistantMessage with partial content |

## Image Input

Models with vision capabilities can process images. You can check if a model supports images via the `input` property. If you pass images to a non-vision model, they are silently ignored.

```typescript
import { readFileSync } from 'fs';
import { getModel, complete } from '@kennyfrc/mu-ai';

const model = getModel('openai', 'gpt-4o-mini');

// Check if model supports images
if (model.input.includes('image')) {
  console.log('Model supports vision');
}

const imageBuffer = readFileSync('image.png');
const base64Image = imageBuffer.toString('base64');

const response = await complete(model, {
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this image?' },
      { type: 'image', data: base64Image, mimeType: 'image/png' }
    ]
  }]
});

// Access the response
for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  }
}
```

## Thinking/Reasoning

Many models support thinking/reasoning capabilities where they can show their internal thought process. You can check if a model supports reasoning via the `reasoning` property. If you pass reasoning options to a non-reasoning model, they are silently ignored.

### Unified Interface (streamSimple/completeSimple)

```typescript
import { getModel, streamSimple, completeSimple } from '@kennyfrc/mu-ai';

// Many models across providers support thinking/reasoning
const model = getModel('anthropic', 'claude-sonnet-4-20250514');
// or getModel('openai', 'gpt-5-mini');
// or getModel('google', 'gemini-2.5-flash');
// or getModel('xai', 'grok-code-fast-1');
// or getModel('groq', 'openai/gpt-oss-20b');
// or getModel('cerebras', 'gpt-oss-120b');
// or getModel('openrouter', 'z-ai/glm-4.5v');

// Check if model supports reasoning
if (model.reasoning) {
  console.log('Model supports reasoning/thinking');
}

// Use the simplified reasoning option
const response = await completeSimple(model, {
  messages: [{ role: 'user', content: 'Solve: 2x + 5 = 13' }]
}, {
  reasoning: 'medium'  // 'minimal' | 'low' | 'medium' | 'high'
});

// Access thinking and text blocks
for (const block of response.content) {
  if (block.type === 'thinking') {
    console.log('Thinking:', block.thinking);
  } else if (block.type === 'text') {
    console.log('Response:', block.text);
  }
}
```

### Provider-Specific Options (stream/complete)

For fine-grained control, use the provider-specific options:

```typescript
import { getModel, complete } from '@kennyfrc/mu-ai';

// OpenAI Reasoning (o1, o3, gpt-5)
const openaiModel = getModel('openai', 'gpt-5-mini');
await complete(openaiModel, context, {
  reasoningEffort: 'medium',
  reasoningSummary: 'detailed'  // OpenAI Responses API only
});

// Anthropic Thinking (Claude Sonnet 4)
const anthropicModel = getModel('anthropic', 'claude-sonnet-4-20250514');
await complete(anthropicModel, context, {
  thinkingEnabled: true,
  thinkingBudgetTokens: 8192  // Optional token limit
});

// Google Gemini Thinking
const googleModel = getModel('google', 'gemini-2.5-flash');
await complete(googleModel, context, {
  thinking: {
    enabled: true,
    budgetTokens: 8192  // -1 for dynamic, 0 to disable
  }
});
```

### Streaming Thinking Content

When streaming, thinking content is delivered through specific events:

```typescript
const s = streamSimple(model, context, { reasoning: 'high' });

for await (const event of s) {
  switch (event.type) {
    case 'thinking_start':
      console.log('[Model started thinking]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);  // Stream thinking content
      break;
    case 'thinking_end':
      console.log('\n[Thinking complete]');
      break;
  }
}
```

## Stop Reasons

Every `AssistantMessage` includes a `stopReason` field that indicates how the generation ended:

- `"stop"` - Normal completion, the model finished its response
- `"length"` - Output hit the maximum token limit
- `"toolUse"` - Model is calling tools and expects tool results
- `"error"` - An error occurred during generation
- `"aborted"` - Request was cancelled via abort signal

## Error Handling

When a request ends with an error (including aborts and tool call validation errors), the streaming API emits an error event:

```typescript
// In streaming
for await (const event of stream) {
  if (event.type === 'error') {
    // event.reason is either "error" or "aborted"
    // event.error is the AssistantMessage with partial content
    console.error(`Error (${event.reason}):`, event.error.errorMessage);
    console.log('Partial content:', event.error.content);
  }
}

// The final message will have the error details
const message = await stream.result();
if (message.stopReason === 'error' || message.stopReason === 'aborted') {
  console.error('Request failed:', message.errorMessage);
  // message.content contains any partial content received before the error
  // message.usage contains partial token counts and costs
}
```

### Aborting Requests

The abort signal allows you to cancel in-progress requests. Aborted requests have `stopReason === 'aborted'`:

```typescript
import { getModel, stream } from '@kennyfrc/mu-ai';

const model = getModel('openai', 'gpt-4o-mini');
const controller = new AbortController();

// Abort after 2 seconds
setTimeout(() => controller.abort(), 2000);

const s = stream(model, {
  messages: [{ role: 'user', content: 'Write a long story' }]
}, {
  signal: controller.signal
});

for await (const event of s) {
  if (event.type === 'text_delta') {
    process.stdout.write(event.delta);
  } else if (event.type === 'error') {
    // event.reason tells you if it was "error" or "aborted"
    console.log(`${event.reason === 'aborted' ? 'Aborted' : 'Error'}:`, event.error.errorMessage);
  }
}

// Get results (may be partial if aborted)
const response = await s.result();
if (response.stopReason === 'aborted') {
  console.log('Request was aborted:', response.errorMessage);
  console.log('Partial content received:', response.content);
  console.log('Tokens used:', response.usage);
}
```

### Continuing After Abort

Aborted messages can be added to the conversation context and continued in subsequent requests:

```typescript
const context = {
  messages: [
    { role: 'user', content: 'Explain quantum computing in detail' }
  ]
};

// First request gets aborted after 2 seconds
const controller1 = new AbortController();
setTimeout(() => controller1.abort(), 2000);

const partial = await complete(model, context, { signal: controller1.signal });

// Add the partial response to context
context.messages.push(partial);
context.messages.push({ role: 'user', content: 'Please continue' });

// Continue the conversation
const continuation = await complete(model, context);
```

## APIs, Models, and Providers

The library implements 4 API interfaces, each with its own streaming function and options:

- **`anthropic-messages`**: Anthropic's Messages API (`streamAnthropic`, `AnthropicOptions`)
- **`google-generative-ai`**: Google's Generative AI API (`streamGoogle`, `GoogleOptions`)
- **`openai-completions`**: OpenAI's Chat Completions API (`streamOpenAICompletions`, `OpenAICompletionsOptions`)
- **`openai-responses`**: OpenAI's Responses API (`streamOpenAIResponses`, `OpenAIResponsesOptions`)

### Providers and Models

A **provider** offers models through a specific API. For example:
- **Anthropic** models use the `anthropic-messages` API
- **Google** models use the `google-generative-ai` API
- **OpenAI** models use the `openai-responses` API
- **xAI, Cerebras, Groq, etc.** models use the `openai-completions` API (OpenAI-compatible)

### Querying Providers and Models

```typescript
import { getProviders, getModels, getModel } from '@kennyfrc/mu-ai';

// Get all available providers
const providers = getProviders();
console.log(providers); // ['openai', 'anthropic', 'google', 'xai', 'groq', ...]

// Get all models from a provider (fully typed)
const anthropicModels = getModels('anthropic');
for (const model of anthropicModels) {
  console.log(`${model.id}: ${model.name}`);
  console.log(`  API: ${model.api}`); // 'anthropic-messages'
  console.log(`  Context: ${model.contextWindow} tokens`);
  console.log(`  Vision: ${model.input.includes('image')}`);
  console.log(`  Reasoning: ${model.reasoning}`);
}

// Get a specific model (both provider and model ID are auto-completed in IDEs)
const model = getModel('openai', 'gpt-4o-mini');
console.log(`Using ${model.name} via ${model.api} API`);
```

### Custom Models

You can create custom models for local inference servers or custom endpoints:

```typescript
import { Model, stream } from '@kennyfrc/mu-ai';

// Example: Ollama using OpenAI-compatible API
const ollamaModel: Model<'openai-completions'> = {
  id: 'llama-3.1-8b',
  name: 'Llama 3.1 8B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 32000
};

// Example: Custom endpoint with headers (bypassing Cloudflare bot detection)
const proxyModel: Model<'anthropic-messages'> = {
  id: 'claude-sonnet-4',
  name: 'Claude Sonnet 4 (Proxied)',
  api: 'anthropic-messages',
  provider: 'custom-proxy',
  baseUrl: 'https://proxy.example.com/v1',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200000,
  maxTokens: 8192,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'X-Custom-Auth': 'bearer-token-here'
  }
};

// Use the custom model
const response = await stream(ollamaModel, context, {
  apiKey: 'dummy' // Ollama doesn't need a real key
});
```

### Type Safety

Models are typed by their API, ensuring type-safe options:

```typescript
// TypeScript knows this is an Anthropic model
const claude = getModel('anthropic', 'claude-sonnet-4-20250514');

// So these options are type-checked for AnthropicOptions
await stream(claude, context, {
  thinkingEnabled: true,      // ✓ Valid for anthropic-messages
  thinkingBudgetTokens: 2048, // ✓ Valid for anthropic-messages
  // reasoningEffort: 'high'  // ✗ TypeScript error: not valid for anthropic-messages
});
```

## Cross-Provider Handoffs

The library supports seamless handoffs between different LLM providers within the same conversation. This allows you to switch models mid-conversation while preserving context, including thinking blocks, tool calls, and tool results.

### How It Works

When messages from one provider are sent to a different provider, the library automatically transforms them for compatibility:

- **User and tool result messages** are passed through unchanged
- **Assistant messages from the same provider/API** are preserved as-is
- **Assistant messages from different providers** have their thinking blocks converted to text with `<thinking>` tags
- **Tool calls and regular text** are preserved unchanged

### Example: Multi-Provider Conversation

```typescript
import { getModel, complete, Context } from '@kennyfrc/mu-ai';

// Start with Claude
const claude = getModel('anthropic', 'claude-sonnet-4-20250514');
const context: Context = {
  messages: []
};

context.messages.push({ role: 'user', content: 'What is 25 * 18?' });
const claudeResponse = await complete(claude, context, {
  thinkingEnabled: true
});
context.messages.push(claudeResponse);

// Switch to GPT-5 - it will see Claude's thinking as <thinking> tagged text
const gpt5 = getModel('openai', 'gpt-5-mini');
context.messages.push({ role: 'user', content: 'Is that calculation correct?' });
const gptResponse = await complete(gpt5, context);
context.messages.push(gptResponse);

// Switch to Gemini
const gemini = getModel('google', 'gemini-2.5-flash');
context.messages.push({ role: 'user', content: 'What was the original question?' });
const geminiResponse = await complete(gemini, context);
```

### Provider Compatibility

All providers can handle messages from other providers, including:
- Text content
- Tool calls and tool results (including images in tool results)
- Thinking/reasoning blocks (transformed to tagged text for cross-provider compatibility)
- Aborted messages with partial content

This enables flexible workflows where you can:
- Start with a fast model for initial responses
- Switch to a more capable model for complex reasoning
- Use specialized models for specific tasks
- Maintain conversation continuity across provider outages

## Context Serialization

The `Context` object can be easily serialized and deserialized using standard JSON methods, making it simple to persist conversations, implement chat history, or transfer contexts between services:

```typescript
import { Context, getModel, complete } from '@kennyfrc/mu-ai';

// Create and use a context
const context: Context = {
  systemPrompt: 'You are a helpful assistant.',
  messages: [
    { role: 'user', content: 'What is TypeScript?' }
  ]
};

const model = getModel('openai', 'gpt-4o-mini');
const response = await complete(model, context);
context.messages.push(response);

// Serialize the entire context
const serialized = JSON.stringify(context);
console.log('Serialized context size:', serialized.length, 'bytes');

// Save to database, localStorage, file, etc.
localStorage.setItem('conversation', serialized);

// Later: deserialize and continue the conversation
const restored: Context = JSON.parse(localStorage.getItem('conversation')!);
restored.messages.push({ role: 'user', content: 'Tell me more about its type system' });

// Continue with any model
const newModel = getModel('anthropic', 'claude-3-5-haiku-20241022');
const continuation = await complete(newModel, restored);
```

> **Note**: If the context contains images (encoded as base64 as shown in the Image Input section), those will also be serialized.

## Agent API

The Agent API provides a higher-level interface for building agents with tools. It handles tool execution, validation, and provides detailed event streaming for interactive applications.

### Event System

The Agent API streams events during execution, allowing you to build reactive UIs and track agent progress. The agent processes prompts in **turns**, where each turn consists of:
1. An assistant message (the LLM's response)
2. Optional tool executions if the assistant calls tools
3. Tool result messages that are fed back to the LLM

This continues until the assistant produces a response without tool calls.

### Event Flow Example

Given a prompt asking to calculate two expressions and sum them:

```typescript
import { agentLoop, AgentContext, calculateTool } from '@kennyfrc/mu-ai';

const context: AgentContext = {
  systemPrompt: 'You are a helpful math assistant.',
  messages: [],
  tools: [calculateTool]
};

const stream = agentLoop(
  { role: 'user', content: 'Calculate 15 * 20 and 30 * 40, then sum the results', timestamp: Date.now() },
  context,
  { model: getModel('openai', 'gpt-4o-mini') }
);

// Expected event sequence:
// 1. agent_start          - Agent begins processing
// 2. turn_start           - First turn begins
// 3. message_start        - User message starts
// 4. message_end          - User message ends
// 5. message_start        - Assistant message starts
// 6. message_update       - Assistant streams response with tool calls
// 7. message_end          - Assistant message ends
// 8. tool_execution_start - First calculation (15 * 20)
// 9. tool_execution_end   - Result: 300
// 10. tool_execution_start - Second calculation (30 * 40)
// 11. tool_execution_end   - Result: 1200
// 12. message_start       - Tool result message for first calculation
// 13. message_end         - Tool result message ends
// 14. message_start       - Tool result message for second calculation
// 15. message_end         - Tool result message ends
// 16. turn_end            - First turn ends with 2 tool results
// 17. turn_start          - Second turn begins
// 18. message_start       - Assistant message starts
// 19. message_update      - Assistant streams response with sum calculation
// 20. message_end         - Assistant message ends
// 21. tool_execution_start - Sum calculation (300 + 1200)
// 22. tool_execution_end   - Result: 1500
// 23. message_start       - Tool result message for sum
// 24. message_end         - Tool result message ends
// 25. turn_end            - Second turn ends with 1 tool result
// 26. turn_start          - Third turn begins
// 27. message_start       - Final assistant message starts
// 28. message_update      - Assistant streams final answer
// 29. message_end         - Final assistant message ends
// 30. turn_end            - Third turn ends with 0 tool results
// 31. agent_end           - Agent completes with all messages
```

### Handling Events

```typescript
for await (const event of stream) {
  switch (event.type) {
    case 'agent_start':
      console.log('Agent started');
      break;

    case 'turn_start':
      console.log('New turn started');
      break;

    case 'message_start':
      console.log(`${event.message.role} message started`);
      break;

    case 'message_update':
      // Only for assistant messages during streaming
      if (event.message.content.some(c => c.type === 'text')) {
        console.log('Assistant:', event.message.content);
      }
      break;

    case 'tool_execution_start':
      console.log(`Calling ${event.toolName} with:`, event.args);
      break;

    case 'tool_execution_end':
      if (event.isError) {
        console.error(`Tool failed:`, event.result);
      } else {
        console.log(`Tool result:`, event.result.output);
      }
      break;

    case 'turn_end':
      console.log(`Turn ended with ${event.toolResults.length} tool calls`);
      break;

    case 'agent_end':
      console.log(`Agent completed with ${event.messages.length} new messages`);
      break;
  }
}

// Get all messages generated during this agent execution
// These include the user message and can be directly appended to context.messages
const messages = await stream.result();
context.messages.push(...messages);
```

### Defining Tools with TypeBox

Tools use TypeBox schemas for runtime validation and type inference:

```typescript
import { Type, Static, AgentTool, AgentToolResult, StringEnum } from '@kennyfrc/mu-ai';

const weatherSchema = Type.Object({
  city: Type.String({ minLength: 1 }),
  units: StringEnum(['celsius', 'fahrenheit'], { default: 'celsius' })
});

type WeatherParams = Static<typeof weatherSchema>;

const weatherTool: AgentTool<typeof weatherSchema, { temp: number }> = {
  label: 'Get Weather',
  name: 'get_weather',
  description: 'Get current weather for a city',
  parameters: weatherSchema,
  execute: async (toolCallId, args) => {
    // args is fully typed: { city: string, units: 'celsius' | 'fahrenheit' }
    const temp = Math.round(Math.random() * 30);
    return {
      output: `Temperature in ${args.city}: ${temp}°${args.units[0].toUpperCase()}`,
      details: { temp }
    };
  }
};

// Tools can also return images alongside text
const chartTool: AgentTool<typeof Type.Object({ data: Type.Array(Type.Number()) })> = {
  label: 'Generate Chart',
  name: 'generate_chart',
  description: 'Generate a chart from data',
  parameters: Type.Object({ data: Type.Array(Type.Number()) }),
  execute: async (toolCallId, args) => {
    const chartImage = await generateChartImage(args.data);
    return {
      content: [
        { type: 'text', text: `Generated chart with ${args.data.length} data points` },
        { type: 'image', data: chartImage.toString('base64'), mimeType: 'image/png' }
      ]
    };
  }
};
```

### Validation and Error Handling

Tool arguments are automatically validated using AJV with the TypeBox schema. Invalid arguments result in detailed error messages:

```typescript
// If the LLM calls with invalid arguments:
// get_weather({ city: '', units: 'kelvin' })

// The tool execution will fail with:
/*
Validation failed for tool "get_weather":
  - city: must NOT have fewer than 1 characters
  - units: must be equal to one of the allowed values

Received arguments:
{
  "city": "",
  "units": "kelvin"
}
*/
```

### Built-in Example Tools

The library includes example tools for common operations:

```typescript
import { calculateTool, getCurrentTimeTool } from '@kennyfrc/mu-ai';

const context: AgentContext = {
  systemPrompt: 'You are a helpful assistant.',
  messages: [],
  tools: [calculateTool, getCurrentTimeTool]
};
```

## Browser Usage

The library supports browser environments. You must pass the API key explicitly since environment variables are not available in browsers:

```typescript
import { getModel, complete } from '@kennyfrc/mu-ai';

// API key must be passed explicitly in browser
const model = getModel('anthropic', 'claude-3-5-haiku-20241022');

const response = await complete(model, {
  messages: [{ role: 'user', content: 'Hello!' }]
}, {
  apiKey: 'your-api-key'
});
```

> **Security Warning**: Exposing API keys in frontend code is dangerous. Anyone can extract and abuse your keys. Only use this approach for internal tools or demos. For production applications, use a backend proxy that keeps your API keys secure.

### Environment Variables (Node.js only)

In Node.js environments, you can set environment variables to avoid passing API keys:

```bash
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
GROQ_API_KEY=gsk_...
CEREBRAS_API_KEY=csk-...
XAI_API_KEY=xai-...
MOONSHOT_API_KEY=...
ZAI_API_KEY=...
OPENROUTER_API_KEY=sk-or-...
```

When set, the library automatically uses these keys:

```typescript
// Uses OPENAI_API_KEY from environment
const model = getModel('openai', 'gpt-4o-mini');
const response = await complete(model, context);

// Or override with explicit key
const response = await complete(model, context, {
  apiKey: 'sk-different-key'
});
```

### Programmatic API Key Management

You can also set and get API keys programmatically:

```typescript
import { setApiKey, getApiKey } from '@kennyfrc/mu-ai';

// Set API key for a provider
setApiKey('openai', 'sk-...');
setApiKey('anthropic', 'sk-ant-...');

// Get API key for a provider (checks both programmatic and env vars)
const key = getApiKey('openai');
```

## License

MIT
