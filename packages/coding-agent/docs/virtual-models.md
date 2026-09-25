# Virtual Models

A virtual model is a selectable model that picks a physical model for each request. Use one to route by task, cost, or conversation state. For example, a router can send quick questions to a small model and hard problems to a large one, while the user selects a single model.

Register virtual models from an [extension](extensions.md). They appear in `/model`, `--model`, scoped models, and settings like any other model.

## Selection and dispatch

A virtual model selects a model and a thinking level. A router maps that pair to a physical pair for each request:

```
selected (virtual model, virtual level)  ->  dispatched (physical model, physical level)
jev/auto:low                             ->  anthropic/claude-sonnet-4-5:high
```

The virtual thinking level is an input to the router. Its meaning is up to the router; it need not correspond to a reasoning budget.

Pi keeps the two pairs apart:

| | Selection | Dispatch |
|---|---|---|
| Recorded in | `model_change` and `thinking_level_change` entries | Each assistant message: `provider`, `api`, `model`, `thinkingLevel` |
| Visible as | `ctx.model`, `ctx.thinkingLevel`, `PI_MODEL`, `PI_REASONING_LEVEL`, `/model` | The assistant message of each response |

Providers only receive physical models. Assistant messages name the physical model, so replaying a conversation across different physical models works the same as after a manual model switch. Resuming a session restores the virtual selection from its latest `model_change` entry. If the virtual model is no longer registered, Pi falls back to the physical model that answered last.

In interactive mode, the footer shows the routed model next to the selection, for example `auto • high → gpt-5.6-luna • medium`. The chat shows a notice such as `Model: openai-codex/gpt-5.6-sol → openai-codex/gpt-5.6-luna • medium` before each response that comes from a different model than the previous one, and before the first routed response as `Model: openai-codex/gpt-5.6-sol • high`. `/session` lists the cost for each physical model.

Compaction and context usage use the limits of the physical model that produced the latest response, even if that response came before switching to the virtual model. Without such a response, they use the limits declared on the virtual model, if any.

## Register a virtual model

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerVirtualModel({
    provider: "router",
    id: "auto",
    name: "Auto",
    thinkingLevels: ["low", "high"],
    route(request, ctx) {
      // Tool follow-ups and retries stay on the model that handled the turn.
      if (request.reason !== "user" && request.previous) {
        return { model: request.previous.model, thinkingLevel: request.previous.thinkingLevel ?? "medium" };
      }
      const id = request.thinkingLevel === "high" ? "claude-sonnet-4-5" : "claude-haiku-4-5";
      return { model: ctx.modelRegistry.find("anthropic", id)!, thinkingLevel: "medium" };
    },
  });
}
```

- `provider` names a provider whose only model is the virtual model. Use an ID that no physical provider uses.
- `thinkingLevels` lists the levels offered for selection. It defaults to `["off"]`.
- `contextWindow` and `maxTokens` are shown before the first response. Unset limits are unknown.
- `input` lists the input types offered for selection. It defaults to text and images; physical models without image support receive placeholders.

The virtual model is registered like `pi.registerProvider()`, with the same queuing and reload rules. `pi.unregisterProvider(provider)` removes it. SDK code can register one without an extension: `modelRuntime.registerNativeProvider(createVirtualProvider(definition))`.

## Route requests

`route(request, ctx)` runs before every request made with the virtual model and returns `{ model, thinkingLevel }`. The model can be any physical model in the catalog whose provider has credentials; look it up with `ctx.modelRegistry`. A virtual model cannot route to another virtual model. Pi clamps the thinking level to the returned model.

| Field | Meaning |
|---|---|
| `model`, `thinkingLevel` | The selected virtual model and level |
| `reason` | Why the request is made, see below |
| `previous` | Physical model and thinking level of the latest successful response in `messages` |
| `messages` | The conversation for this request, including system messages |
| `signal` | Abort signal of the request |

| `reason` | Request |
|---|---|
| `user` | First request after a message the user wrote, including steering and follow-up messages |
| `continuation` | Any other request in the agent loop, such as after tool results or extension messages |
| `retry` | Automatic retry after a failed request |
| `direct` | Request made outside the agent loop, such as a compaction summary or an extension calling `ctx.modelRegistry.streamSimple()` |

Returning `previous` for `continuation` and `retry` keeps prompt caches and thinking signatures valid. Switching models between turns is allowed but loses the prompt cache.

If `route()` throws, or returns a virtual model or a model without credentials, the request ends with an error response.

## Keep routing state

The transcript already records the selection and every dispatched model, and `ctx.sessionManager.getBranch()` exposes both. Store only what the transcript lacks, such as classifier results, with `pi.appendEntry()`. Custom entries follow the session tree, so forks and `/tree` navigation see the matching history.

Routers can call other models through `ctx.modelRegistry`, for example `ctx.modelRegistry.classify()` with a classifier model from `ctx.modelRegistry.findOfType("classifier", provider, id)`. The call adds latency before the first token of the turn.

See [`jev-router.ts`](../examples/extensions/jev-router.ts) for a complete router. It plans on a strong OpenAI Codex model chosen by the Jev classifier, lets that model make the first edit, and then switches once to a cheaper model, accepting a single prompt-cache miss. It records the phase as custom entries from a `turn_end` handler.
