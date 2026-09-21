# Ollama

Pi uses Ollama's native `/api/chat` API for local models. Ollama 0.20 or newer is required. Cloud-backed model entries are excluded from discovery.

## Setup

Install and start Ollama, and pull a model that supports tools. In Pi, run `/login ollama`, accept `http://127.0.0.1:11434`, and leave the API key empty. Then choose an installed model with `/model`.

For a terminal on macOS or Linux:

```bash
export OLLAMA_BASE_URL=http://127.0.0.1:11434
pi --list-models ollama
pi --provider ollama --model qwen3.5:4b
```

In Windows PowerShell:

```powershell
$env:OLLAMA_BASE_URL = "http://127.0.0.1:11434"
pi --list-models ollama
pi --provider ollama --model qwen3.5:4b
```

Replace the model name with one installed on your server. These commands use the same native provider on each platform; model speed and available memory depend on the host running Ollama.

## Configuration and discovery

- Endpoint precedence: stored `auth.json` entry → `OLLAMA_BASE_URL` → `OLLAMA_HOST`. The library factory's explicit `baseUrl` takes priority over these.
- Local Ollama needs no API key. `OLLAMA_API_KEY` or an optional stored key supports authenticated proxies.
- Pi queries `/api/version`, `/api/tags`, and `/api/show` to discover installed chat models and their reasoning/image capabilities. Discovery does not load model weights.
- Configure an endpoint explicitly; unrelated Pi sessions do not probe localhost automatically.
- The first configured startup discovers models before selection. Later startups can use the endpoint's cached catalog. `/ollama` refreshes it after model changes.
- `--offline` disables discovery, including local discovery. Previously cached models and explicitly configured models remain usable for inference. It does not make inference offline from a configured server.
- Discovery preserves the previous catalog on a failed refresh. A changed endpoint never restores another endpoint's cached models.

Existing `models.json` entries using `api: "openai-completions"` under the `ollama` provider keep their configured API key and URL, including the `/v1` prefix. They work without native discovery setup. `OLLAMA_BASE_URL`, `OLLAMA_HOST`, and the endpoint stored by `/login ollama` select the native server; they do not replace compatibility models' URLs. Stored credentials retain their normal precedence over `models.json` keys.

## Context and output limits

The model's trained maximum is often much larger than an appropriate runtime allocation. Pi uses the model's saved `num_ctx` parameter when present, otherwise **8192 tokens**, bounded by its trained maximum when reported. The default output cap is the smaller of 4096 and half the context window.

Every request sends Pi's selected `contextWindow` as `options.num_ctx` and the output limit as `options.num_predict`. Ollama's server-wide context default is therefore superseded for Pi requests. Increasing context consumes more memory; choose a larger value appropriate for your model and machine when working with larger repositories.

8192 is a conservative allocation, not a recommended size for every repository. System instructions, tools, retained history, and generation all share that window. Use a larger explicit context for substantial file reads when your server has enough memory. A remote server's `OLLAMA_CONTEXT_LENGTH` cannot be read from the client's environment; configure the intended window in Pi or save `num_ctx` on the Ollama model.

Override a discovered model in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "ollama": {
      "modelOverrides": {
        "qwen3.5:4b": { "contextWindow": 32768, "maxTokens": 4096 }
      }
    }
  }
}
```

Check Ollama's actual allocation with `ollama ps`. Pi requests `truncate: false` and `shift: false` so context overflow is reported rather than silently discarding history. Sampling overrides cannot replace the selected context or output budgets; low-level `onPayload` hooks can intentionally replace the request.

When switching a large conversation to a smaller window, Pi first summarizes with the current model. It checks the estimated size of the checkpoint, retained history, system prompt, and tools before committing the switch. A failed or oversized summary keeps the current model and history. Estimates are not a tokenizer guarantee; actual overflow remains an explicit error handled by Pi's bounded compaction recovery. A very small window or one oversized retained turn may require a larger context or a new session.

If compaction's configured reserve plus retained-history budget does not fit the selected window, each is capped at one quarter of that window. With the default settings and an 8192-token window, both become 2048. History summaries then receive up to 1638 output tokens and turn-prefix summaries up to 1024, further limited by `maxTokens`. Increasing only `maxTokens` does not increase those text budgets.

## Thinking and tools

`--thinking off` sends `think: false` to models that support reasoning. Other supported Pi levels enable thinking. Models such as GPT-OSS use effort values and cannot disable reasoning; their advertised thinking levels reflect that limitation. Thinking and the final answer share the output budget.

Discovered Ollama models declare `thinkingBudgetMode: "shared"`, enabling Pi's generic summary budget policy. Thinking is disabled when the model permits it. For models that require thinking, Pi selects the lowest supported level and allows up to 2048 additional generation tokens, bounded by the model output limit and estimated remaining context. This applies to compaction, smaller-window switching, and branch summaries. Ordinary conversation keeps the selected thinking level. There is no separate hard reasoning-token limit in this API; an incomplete summary still fails safely. Custom full model definitions should also declare this property; see [thinking budgets](models.md#thinking-budgets-for-summaries).

Pi preserves native thinking, text, parallel tool calls, tool results, and images across turns. A truncated or failed stream ends as an error, so its tool calls do not execute. Incomplete summaries are not saved as checkpoints.

Discovery does not certify coding ability. Use a tool-capable model and validate its edits and commands; small models and mixed-model histories can produce different results even with identical transport settings.

Check the model's capabilities with `ollama show MODEL` and look for `tools` before using Pi's coding tools. Discovery also exposes completion models without tool support for library chat and `--no-tools` sessions.

## SDK initialization

`createAgentSession()` includes the built-in Ollama and llama.cpp extensions when it creates its default resource loader. This registers their providers and commands before initial model selection. Supplying a custom `resourceLoader` gives the embedder control over its extension factories. Only configured dynamic providers with an empty cached catalog need startup discovery; `--offline` / `PI_OFFLINE` disables that discovery.

## Library use

```ts
import { createModels } from "@earendil-works/pi-ai";
import { ollamaProvider } from "@earendil-works/pi-ai/providers/ollama";

const models = createModels();
models.setProvider(ollamaProvider({ baseUrl: "http://127.0.0.1:11434" }));
const refreshed = await models.refresh();
if (refreshed.errors.size) throw refreshed.errors.get("ollama");
const model = models.getModel("ollama", "qwen3.5:4b");
if (!model) throw new Error("Install the model in Ollama first");
const reply = await models.completeSimple(model, {
  messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
});
```

The API identifier is `ollama-chat`. Full API options additionally support `think` and `keepAlive`. Request hooks, custom fetch, cancellation, and HTTP timeouts are supported. `timeoutMs` is an inactivity limit: it bounds the wait for response headers and resets whenever non-empty response data arrives. An active generation can run longer than this limit. Pi supplies its `httpIdleTimeoutMs` setting (five minutes by default); callers can use an abort signal to impose a total deadline. The adapter does not automatically replay failed HTTP requests; Pi owns its bounded retry policy.
