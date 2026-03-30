# @mariozechner/pi-ai

Unified LLM API with automatic model discovery, provider configuration, token and cost tracking, and simple context persistence and hand-off to other models mid-session.

**Note**: This library only includes models that support tool calling (function calling), as this is essential for agentic workflows.

## Table of Contents

- [Supported Providers](#supported-providers)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Tools](#tools)
  - [Defining Tools](#defining-tools)
  - [Handling Tool Calls](#handling-tool-calls)
  - [Streaming Tool Calls with Partial JSON](#streaming-tool-calls-with-partial-json)
  - [Validating Tool Arguments](#validating-tool-arguments)
  - [Complete Event Reference](#complete-event-reference)
- [Image Input](#image-input)
- [Thinking/Reasoning](#thinkingreasoning)
  - [Unified Interface](#unified-interface-streamsimplecompletesimple)
  - [Provider-Specific Options](#provider-specific-options-streamcomplete)
  - [Streaming Thinking Content](#streaming-thinking-content)
- [Stop Reasons](#stop-reasons)
- [Error Handling](#error-handling)
  - [Aborting Requests](#aborting-requests)
  - [Continuing After Abort](#continuing-after-abort)
- [APIs, Models, and Providers](#apis-models-and-providers)
  - [Providers and Models](#providers-and-models)
  - [Querying Providers and Models](#querying-providers-and-models)
  - [Custom Models](#custom-models)
  - [OpenAI Compatibility Settings](#openai-compatibility-settings)
  - [Type Safety](#type-safety)
- [Cross-Provider Handoffs](#cross-provider-handoffs)
- [Context Serialization](#context-serialization)
- [Browser Usage](#browser-usage)
  - [Browser Compatibility Notes](#browser-compatibility-notes)
  - [Environment Variables](#environment-variables-nodejs-only)
  - [Checking Environment Variables](#checking-environment-variables)
- [OAuth Providers](#oauth-providers)
  - [Vertex AI](#vertex-ai)
  - [CLI Login](#cli-login)
  - [Programmatic OAuth](#programmatic-oauth)
  - [Login Flow Example](#login-flow-example)
  - [Using OAuth Tokens](#using-oauth-tokens)
  - [Provider Notes](#provider-notes)
- [License](#license)

## Supported Providers

- **OpenAI**
- **Azure OpenAI (Responses)**
- **OpenAI Codex** (ChatGPT Plus/Pro subscription, requires OAuth, see below)
- **Anthropic**
- **Google**
- **Vertex AI** (Gemini via Vertex AI)
- **Mistral**
- **Groq**
- **Cerebras**
- **xAI**
- **OpenRouter**
- **Vercel AI Gateway**
- **MiniMax**
- **GitHub Copilot** (requires OAuth, see below)
- **Google Gemini CLI** (requires OAuth, see below)
- **Antigravity** (requires OAuth, see below)
- **Amazon Bedrock**
- **OpenCode Zen**
- **OpenCode Go**
- **Kimi For Coding** (Moonshot AI, uses Anthropic-compatible API)
- **Any OpenAI-compatible API**: Ollama, vLLM, LM Studio, etc.

## Installation

```bash
npm install @mariozechner/pi-ai
```

TypeBox exports are re-exported from `@mariozechner/pi-ai`: `Type`, `Static`, and `TSchema`.

## Quick Start

```typescript
import { Type, getModel, stream, complete, Context, Tool, StringEnum } from '@mariozechner/pi-ai';

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
import { Type, Tool, StringEnum } from '@mariozechner/pi-ai';

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
    // Execute your tool with the arguments
    // See "Validating Tool Arguments" section for validation
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
    // Here toolCall.arguments is complete (but not yet validated)
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
- The Google provider does not support function call streaming. Instead, you will receive a single `toolcall_delta` event with the full arguments.

### Validating Tool Arguments

When using `agentLoop`, tool arguments are automatically validated against your TypeBox schemas before execution. If validation fails, the error is returned to the model as a tool result, allowing it to retry.

When implementing your own tool execution loop with `stream()` or `complete()`, use `validateToolCall` to validate arguments before passing them to your tools:

```typescript
import { stream, validateToolCall, Tool } from '@mariozechner/pi-ai';

const tools: Tool[] = [weatherTool, calculatorTool];
const s = stream(model, { messages, tools });

for await (const event of s) {
  if (event.type === 'toolcall_end') {
    const toolCall = event.toolCall;

    try {
      // Validate arguments against the tool's schema (throws on invalid args)
      const validatedArgs = validateToolCall(tools, toolCall);
      const result = await executeMyTool(toolCall.name, validatedArgs);
      // ... add tool result to context
    } catch (error) {
      // Validation failed - return error as tool result so model can retry
      context.messages.push({
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: 'text', text: error.message }],
        isError: true,
        timestamp: Date.now()
      });
    }
  }
}
```

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
import { getModel, complete } from '@mariozechner/pi-ai';

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
import { getModel, streamSimple, completeSimple } from '@mariozechner/pi-ai';

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
  reasoning: 'medium'  // 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' (xhigh maps to high on non-OpenAI providers)
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
import { getModel, complete } from '@mariozechner/pi-ai';

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

`AssistantMessage` may also include `responseId`, a provider-specific upstream response or message identifier when the underlying API exposes one. Do not assume it is always present across providers.

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
import { getModel, stream } from '@mariozechner/pi-ai';

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

### Debugging Provider Payloads

Use the `onPayload` callback to inspect the request payload sent to the provider. This is useful for debugging request formatting issues or provider validation errors.

```typescript
const response = await complete(model, context, {
  onPayload: (payload) => {
    console.log('Provider payload:', JSON.stringify(payload, null, 2));
  }
});
```

The callback is supported by `stream`, `complete`, `streamSimple`, and `completeSimple`.

## APIs, Models, and Providers

The library uses a registry of API implementations. Built-in APIs include:

- **`anthropic-messages`**: Anthropic Messages API (`streamAnthropic`, `AnthropicOptions`)
- **`google-generative-ai`**: Google Generative AI API (`streamGoogle`, `GoogleOptions`)
- **`google-gemini-cli`**: Google Cloud Code Assist API (`streamGoogleGeminiCli`, `GoogleGeminiCliOptions`)
- **`google-vertex`**: Google Vertex AI API (`streamGoogleVertex`, `GoogleVertexOptions`)
- **`mistral-conversations`**: Mistral Conversations API (`streamMistral`, `MistralOptions`)
- **`openai-completions`**: OpenAI Chat Completions API (`streamOpenAICompletions`, `OpenAICompletionsOptions`)
- **`openai-responses`**: OpenAI Responses API (`streamOpenAIResponses`, `OpenAIResponsesOptions`)
- **`openai-codex-responses`**: OpenAI Codex Responses API (`streamOpenAICodexResponses`, `OpenAICodexResponsesOptions`)
- **`azure-openai-responses`**: Azure OpenAI Responses API (`streamAzureOpenAIResponses`, `AzureOpenAIResponsesOptions`)
- **`bedrock-converse-stream`**: Amazon Bedrock Converse API (`streamBedrock`, `BedrockOptions`)

### Faux provider for tests

`registerFauxProvider()` registers a temporary in-memory provider for tests and demos. It is opt-in and not part of the built-in provider set.

```typescript
import {
  complete,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  registerFauxProvider,
  stream,
} from '@mariozechner/pi-ai';

const registration = registerFauxProvider({
  tokensPerSecond: 50 // optional
});

const model = registration.getModel();
const context = {
  messages: [{ role: 'user', content: 'Summarize package.json and then call echo', timestamp: Date.now() }]
};

registration.setResponses([
  fauxAssistantMessage([
    fauxThinking('Need to inspect package metadata first.'),
    fauxToolCall('echo', { text: 'package.json' })
  ], { stopReason: 'toolUse' })
]);

const first = await complete(model, context, {
  sessionId: 'session-1',
  cacheRetention: 'short'
});
context.messages.push(first);

context.messages.push({
  role: 'toolResult',
  toolCallId: first.content.find((block) => block.type === 'toolCall')!.id,
  toolName: 'echo',
  content: [{ type: 'text', text: 'package.json contents here' }],
  isError: false,
  timestamp: Date.now()
});

registration.setResponses([
  fauxAssistantMessage([
    fauxThinking('Now I can summarize the tool output.'),
    fauxText('Here is the summary.')
  ])
]);

const s = stream(model, context);
for await (const event of s) {
  console.log(event.type);
}

// Optional: register multiple faux models for model-switching tests
const multiModel = registerFauxProvider({
  models: [
    { id: 'faux-fast', reasoning: false },
    { id: 'faux-thinker', reasoning: true }
  ]
});
const thinker = multiModel.getModel('faux-thinker');

console.log(thinker?.reasoning);
console.log(registration.getPendingResponseCount());
console.log(registration.state.callCount);
registration.unregister();
multiModel.unregister();
```

Notes:
- Responses are consumed from a queue in request start order.
- If the queue is empty, the faux provider returns an assistant error message with `errorMessage: "No more faux responses queued"`.
- Use `registration.setResponses([...])` to replace the remaining queue and `registration.appendResponses([...])` to add more responses.
- `registration.models` exposes all registered faux models. `registration.getModel()` returns the first one, and `registration.getModel(id)` returns a specific one.
- Use `fauxAssistantMessage(...)` for scripted assistant replies. Use `fauxText(...)`, `fauxThinking(...)`, and `fauxToolCall(...)` to build content blocks without filling in low-level fields manually.
- `registration.unregister()` removes the temporary provider from the global API registry.
- Usage is estimated at roughly 1 token per 4 characters. When `sessionId` is present and `cacheRetention` is not `"none"`, prompt cache reads and writes are simulated automatically.
- Tool call arguments stream incrementally via `toolcall_delta` chunks.
- By default, each streamed chunk is emitted on its own microtask. Set `tokensPerSecond` to pace chunk delivery in real time.
- The intended use is one deterministic scripted flow per registration. If you need independent concurrent flows, register separate faux providers.

### Providers and Models

A **provider** offers models through a specific API. For example:
- **Anthropic** models use the `anthropic-messages` API
- **Google** models use the `google-generative-ai` API
- **OpenAI** models use the `openai-responses` API
- **Mistral** models use the `mistral-conversations` API
- **xAI, Cerebras, Groq, etc.** models use the `openai-completions` API (OpenAI-compatible)

### Querying Providers and Models

```typescript
import { getProviders, getModels, getModel } from '@mariozechner/pi-ai';

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
import { Model, stream } from '@mariozechner/pi-ai';

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

// Example: LiteLLM proxy with explicit compat settings
const litellmModel: Model<'openai-completions'> = {
  id: 'gpt-4o',
  name: 'GPT-4o (via LiteLLM)',
  api: 'openai-completions',
  provider: 'litellm',
  baseUrl: 'http://localhost:4000/v1',
  reasoning: false,
  input: ['text', 'image'],
  cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 16384,
  compat: {
    supportsStore: false,  // LiteLLM doesn't support the store field
  }
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

Some OpenAI-compatible servers do not understand the `developer` role used for reasoning-capable models. For those providers, set `compat.supportsDeveloperRole` to `false` so the system prompt is sent as a `system` message instead. If the server also does not support `reasoning_effort`, set `compat.supportsReasoningEffort` to `false` too.

This commonly applies to Ollama, vLLM, SGLang, and similar OpenAI-compatible servers. You can set `compat` at the provider level or per model.

```typescript
const ollamaReasoningModel: Model<'openai-completions'> = {
  id: 'gpt-oss:20b',
  name: 'GPT-OSS 20B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 32000,
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
  }
};
```

### OpenAI Compatibility Settings

The `openai-completions` API is implemented by many providers with minor differences. By default, the library auto-detects compatibility settings based on `baseUrl` for a small set of known OpenAI-compatible providers (Cerebras, xAI, Chutes, DeepSeek, zAi, OpenCode, etc.). For custom proxies or unknown endpoints, you can override these settings via the `compat` field. For `openai-responses` models, the compat field only supports Responses-specific flags.

```typescript
interface OpenAICompletionsCompat {
  supportsStore?: boolean;           // Whether provider supports the `store` field (default: true)
  supportsDeveloperRole?: boolean;   // Whether provider supports `developer` role vs `system` (default: true)
  supportsReasoningEffort?: boolean; // Whether provider supports `reasoning_effort` (default: true)
  supportsUsageInStreaming?: boolean; // Whether provider supports `stream_options: { include_usage: true }` (default: true)
  supportsStrictMode?: boolean;      // Whether provider supports `strict` in tool definitions (default: true)
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';  // Which field name to use (default: max_completion_tokens)
  requiresToolResultName?: boolean;  // Whether tool results require the `name` field (default: false)
  requiresAssistantAfterToolResult?: boolean; // Whether tool results must be followed by an assistant message (default: false)
  requiresThinkingAsText?: boolean;  // Whether thinking blocks must be converted to text (default: false)
  thinkingFormat?: 'openai' | 'zai' | 'qwen'; // Format for reasoning param: 'openai' uses reasoning_effort, 'zai' uses thinking: { type: "enabled" }, 'qwen' uses enable_thinking: boolean (default: openai)
  openRouterRouting?: OpenRouterRouting; // OpenRouter routing preferences (default: {})
  vercelGatewayRouting?: VercelGatewayRouting; // Vercel AI Gateway routing preferences (default: {})
}

interface OpenAIResponsesCompat {
  // Reserved for future use
}
```

If `compat` is not set, the library falls back to URL-based detection. If `compat` is partially set, unspecified fields use the detected defaults. This is useful for:

- **LiteLLM proxies**: May not support `store` field
- **Custom inference servers**: May use non-standard field names
- **Self-hosted endpoints**: May have different feature support

### Type Safety

Models are typed by their API, which keeps the model metadata accurate. Provider-specific option types are enforced when you call the provider functions directly. The generic `stream` and `complete` functions accept `StreamOptions` with additional provider fields.

```typescript
import { streamAnthropic, type AnthropicOptions } from '@mariozechner/pi-ai';

// TypeScript knows this is an Anthropic model
const claude = getModel('anthropic', 'claude-sonnet-4-20250514');

const options: AnthropicOptions = {
  thinkingEnabled: true,
  thinkingBudgetTokens: 2048
};

await streamAnthropic(claude, context, options);
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
import { getModel, complete, Context } from '@mariozechner/pi-ai';

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
import { Context, getModel, complete } from '@mariozechner/pi-ai';

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

## Browser Usage

The library supports browser environments. You must pass the API key explicitly since environment variables are not available in browsers:

```typescript
import { getModel, complete } from '@mariozechner/pi-ai';

// API key must be passed explicitly in browser
const model = getModel('anthropic', 'claude-3-5-haiku-20241022');

const response = await complete(model, {
  messages: [{ role: 'user', content: 'Hello!' }]
}, {
  apiKey: 'your-api-key'
});
```

> **Security Warning**: Exposing API keys in frontend code is dangerous. Anyone can extract and abuse your keys. Only use this approach for internal tools or demos. For production applications, use a backend proxy that keeps your API keys secure.

### Browser Compatibility Notes

- Amazon Bedrock (`bedrock-converse-stream`) is not supported in browser environments.
- OAuth login flows are not supported in browser environments. Use the `@mariozechner/pi-ai/oauth` entry point in Node.js.
- In browser builds, Bedrock can still appear in model lists. Calls to Bedrock models fail at runtime.
- Use a server-side proxy or backend service if you need Bedrock or OAuth-based auth from a web app.

### Environment Variables (Node.js only)

In Node.js environments, you can set environment variables to avoid passing API keys:

| Provider | Environment Variable(s) |
|----------|------------------------|
| OpenAI | `OPENAI_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME` (optional `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` like `model=deployment,model2=deployment2`) |
| Anthropic | `ANTHROPIC_API_KEY` or `ANTHROPIC_OAUTH_TOKEN` |
| Google | `GEMINI_API_KEY` |
| Vertex AI | `GOOGLE_CLOUD_API_KEY` or `GOOGLE_CLOUD_PROJECT` (or `GCLOUD_PROJECT`) + `GOOGLE_CLOUD_LOCATION` + ADC |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| xAI | `XAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| zAI | `ZAI_API_KEY` |
| MiniMax | `MINIMAX_API_KEY` |
| OpenCode Zen / OpenCode Go | `OPENCODE_API_KEY` |
| Kimi For Coding | `KIMI_API_KEY` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` or `GH_TOKEN` or `GITHUB_TOKEN` |

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

#### Antigravity Version Override

Set `PI_AI_ANTIGRAVITY_VERSION` to override the Antigravity User-Agent version when Google updates their requirements:

```bash
export PI_AI_ANTIGRAVITY_VERSION="1.23.0"
```

#### Cache Retention

Set `PI_CACHE_RETENTION=long` to extend prompt cache retention:

| Provider | Default | With `PI_CACHE_RETENTION=long` |
|----------|---------|-------------------------------|
| Anthropic | 5 minutes | 1 hour |
| OpenAI | in-memory | 24 hours |

This only affects direct API calls to `api.anthropic.com` and `api.openai.com`. Proxies and other providers are unaffected.

> **Note**: Extended cache retention may increase costs for Anthropic (cache writes are charged at a higher rate). OpenAI's 24h retention has no additional cost.

### Checking Environment Variables

```typescript
import { getEnvApiKey } from '@mariozechner/pi-ai';

// Check if an API key is set in environment variables
const key = getEnvApiKey('openai');  // checks OPENAI_API_KEY
```

## OAuth Providers

Several providers require OAuth authentication instead of static API keys:

- **Anthropic** (Claude Pro/Max subscription)
- **OpenAI Codex** (ChatGPT Plus/Pro subscription, access to GPT-5.x Codex models)
- **GitHub Copilot** (Copilot subscription)
- **Google Gemini CLI** (Gemini 2.0/2.5 via Google Cloud Code Assist; free tier or paid subscription)
- **Antigravity** (Free Gemini 3, Claude, GPT-OSS via Google Cloud)

For paid Cloud Code Assist subscriptions, set `GOOGLE_CLOUD_PROJECT` or `GOOGLE_CLOUD_PROJECT_ID` to your project ID.

### Vertex AI

Vertex AI models support either a Google Cloud API key or Application Default Credentials (ADC):

- **API key**: Set `GOOGLE_CLOUD_API_KEY` or pass `apiKey` in the call options.
- **Local development (ADC)**: Run `gcloud auth application-default login`
- **CI/Production (ADC)**: Set `GOOGLE_APPLICATION_CREDENTIALS` to point to a service account JSON key file

When using ADC, also set `GOOGLE_CLOUD_PROJECT` (or `GCLOUD_PROJECT`) and `GOOGLE_CLOUD_LOCATION`. You can also pass `project`/`location` in the call options. When using `GOOGLE_CLOUD_API_KEY`, `project` and `location` are not required.

Example:

```bash
# Local (uses your user credentials)
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT="my-project"
export GOOGLE_CLOUD_LOCATION="us-central1"

# CI/Production (service account key file)
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
```

```typescript
import { getModel, complete } from '@mariozechner/pi-ai';

(async () => {
  const model = getModel('google-vertex', 'gemini-2.5-flash');
  const response = await complete(model, {
    messages: [{ role: 'user', content: 'Hello from Vertex AI' }]
  }, {
    apiKey: process.env.GOOGLE_CLOUD_API_KEY,
  });

  for (const block of response.content) {
    if (block.type === 'text') console.log(block.text);
  }
})().catch(console.error);
```

Official docs: [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials)

### CLI Login

The quickest way to authenticate:

```bash
npx @mariozechner/pi-ai login              # interactive provider selection
npx @mariozechner/pi-ai login anthropic    # login to specific provider
npx @mariozechner/pi-ai list               # list available providers
```

Credentials are saved to `auth.json` in the current directory.

### Programmatic OAuth

The library provides login and token refresh functions via the `@mariozechner/pi-ai/oauth` entry point. Credential storage is the caller's responsibility.

```typescript
import {
  // Login functions (return credentials, do not store)
  loginAnthropic,
  loginOpenAICodex,
  loginGitHubCopilot,
  loginGeminiCli,
  loginAntigravity,

  // Token management
  refreshOAuthToken,   // (provider, credentials) => new credentials
  getOAuthApiKey,      // (provider, credentialsMap) => { newCredentials, apiKey } | null

  // Types
  type OAuthProvider,  // 'anthropic' | 'openai-codex' | 'github-copilot' | 'google-gemini-cli' | 'google-antigravity'
  type OAuthCredentials,
} from '@mariozechner/pi-ai/oauth';
```

### Login Flow Example

```typescript
import { loginGitHubCopilot } from '@mariozechner/pi-ai/oauth';
import { writeFileSync } from 'fs';

const credentials = await loginGitHubCopilot({
  onAuth: (url, instructions) => {
    console.log(`Open: ${url}`);
    if (instructions) console.log(instructions);
  },
  onPrompt: async (prompt) => {
    return await getUserInput(prompt.message);
  },
  onProgress: (message) => console.log(message)
});

// Store credentials yourself
const auth = { 'github-copilot': { type: 'oauth', ...credentials } };
writeFileSync('auth.json', JSON.stringify(auth, null, 2));
```

### Using OAuth Tokens

Use `getOAuthApiKey()` to get an API key, automatically refreshing if expired:

```typescript
import { getModel, complete } from '@mariozechner/pi-ai';
import { getOAuthApiKey } from '@mariozechner/pi-ai/oauth';
import { readFileSync, writeFileSync } from 'fs';

// Load your stored credentials
const auth = JSON.parse(readFileSync('auth.json', 'utf-8'));

// Get API key (refreshes if expired)
const result = await getOAuthApiKey('github-copilot', auth);
if (!result) throw new Error('Not logged in');

// Save refreshed credentials
auth['github-copilot'] = { type: 'oauth', ...result.newCredentials };
writeFileSync('auth.json', JSON.stringify(auth, null, 2));

// Use the API key
const model = getModel('github-copilot', 'gpt-4o');
const response = await complete(model, {
  messages: [{ role: 'user', content: 'Hello!' }]
}, { apiKey: result.apiKey });
```

### Provider Notes

**OpenAI Codex**: Requires a ChatGPT Plus or Pro subscription. Provides access to GPT-5.x Codex models with extended context windows and reasoning capabilities. The library automatically handles session-based prompt caching when `sessionId` is provided in stream options. You can set `transport` in stream options to `"sse"`, `"websocket"`, or `"auto"` for Codex Responses transport selection. When using WebSocket with a `sessionId`, connections are reused per session and expire after 5 minutes of inactivity.

**Azure OpenAI (Responses)**: Uses the Responses API only. Set `AZURE_OPENAI_API_KEY` and either `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME`. Use `AZURE_OPENAI_API_VERSION` (defaults to `v1`) to override the API version if needed. Deployment names are treated as model IDs by default, override with `azureDeploymentName` or `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` using comma-separated `model-id=deployment` pairs (for example `gpt-4o-mini=my-deployment,gpt-4o=prod`). Legacy deployment-based URLs are intentionally unsupported.

**GitHub Copilot**: If you get "The requested model is not supported" error, enable the model manually in VS Code: open Copilot Chat, click the model selector, select the model (warning icon), and click "Enable".

**Google Gemini CLI / Antigravity**: These use Google Cloud OAuth. The `apiKey` returned by `getOAuthApiKey()` is a JSON string containing both the token and project ID, which the library handles automatically.

## Development

### Adding a New Provider

Adding a new LLM provider requires changes across multiple files. This checklist covers all necessary steps:

#### 1. Core Types (`src/types.ts`)

- Add the API identifier to `KnownApi` (for example `"bedrock-converse-stream"`)
- Create an options interface extending `StreamOptions` (for example `BedrockOptions`)
- Add the provider name to `KnownProvider` (for example `"amazon-bedrock"`)

#### 2. Provider Implementation (`src/providers/`)

Create a new provider file (for example `amazon-bedrock.ts`) that exports:

- `stream<Provider>()` function returning `AssistantMessageEventStream`
- `streamSimple<Provider>()` for `SimpleStreamOptions` mapping
- Provider-specific options interface
- Message conversion functions to transform `Context` to provider format
- Tool conversion if the provider supports tools
- Response parsing to emit standardized events (`text`, `tool_call`, `thinking`, `usage`, `stop`)

#### 3. API Registry Integration (`src/providers/register-builtins.ts`)

- Register the API with `registerApiProvider()`
- Add a package subpath export in `package.json` for the provider module (`./dist/providers/<provider>.js`)
- Add lazy loader wrappers in `src/providers/register-builtins.ts`, do not statically import provider implementation modules there
- Add any root-level `export type` re-exports in `src/index.ts` that should remain available from `@mariozechner/pi-ai`
- Add credential detection in `env-api-keys.ts` for the new provider
- Ensure `streamSimple` handles auth lookup via `getEnvApiKey()` or provider-specific auth

#### 4. Model Generation (`scripts/generate-models.ts`)

- Add logic to fetch and parse models from the provider's source (e.g., models.dev API)
- Map provider model data to the standardized `Model` interface
- Handle provider-specific quirks (pricing format, capability flags, model ID transformations)

#### 5. Tests (`test/`)

Create or update test files to cover the new provider:

- `stream.test.ts` - Basic streaming and tool use
- `tokens.test.ts` - Token usage reporting
- `abort.test.ts` - Request cancellation
- `empty.test.ts` - Empty message handling
- `context-overflow.test.ts` - Context limit errors
- `image-limits.test.ts` - Image support (if applicable)
- `unicode-surrogate.test.ts` - Unicode handling
- `tool-call-without-result.test.ts` - Orphaned tool calls
- `image-tool-result.test.ts` - Images in tool results
- `total-tokens.test.ts` - Token counting accuracy
- `cross-provider-handoff.test.ts` - Cross-provider context replay

For `cross-provider-handoff.test.ts`, add at least one provider/model pair. If the provider exposes multiple model families (for example GPT and Claude), add at least one pair per family.

For providers with non-standard auth (AWS, Google Vertex), create a utility like `bedrock-utils.ts` with credential detection helpers.

#### 6. Coding Agent Integration (`../coding-agent/`)

Update `src/core/model-resolver.ts`:

- Add a default model ID for the provider in `DEFAULT_MODELS`

Update `src/cli/args.ts`:

- Add environment variable documentation in the help text

Update `README.md`:

- Add the provider to the providers section with setup instructions

#### 7. Documentation

Update `packages/ai/README.md`:

- Add to the Supported Providers table
- Document any provider-specific options or authentication requirements
- Add environment variable to the Environment Variables section

#### 8. Changelog

Add an entry to `packages/ai/CHANGELOG.md` under `## [Unreleased]`:

```markdown
### Added
- Added support for [Provider Name] provider ([#PR](link) by [@author](link))
```

## License

MIT
