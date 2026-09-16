# Ollama

Pi uses Ollama's native `/api/chat` API for local models. Ollama 0.20 or newer is required. Cloud-backed model entries are excluded from discovery.

## Setup

Install and start Ollama, and pull a model that supports tools. In Pi, run `/login ollama`, accept `http://127.0.0.1:11434`, and leave the API key empty. Then choose an installed model with `/model`.

For a terminal on macOS or Linux:

```bash
export OLLAMA_BASE_URL=http://127.0.0.1:11434
pi --list-models ollama
pi --provider ollama --model qwen3.5:4b --thinking off
```

In Windows PowerShell:

```powershell
$env:OLLAMA_BASE_URL = "http://127.0.0.1:11434"
pi --list-models ollama
pi --provider ollama --model qwen3.5:4b --thinking off
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

## Context and output limits

The model's trained maximum is often much larger than an appropriate runtime allocation. Pi uses the model's saved `num_ctx` parameter when present, otherwise **8192 tokens**, bounded by its trained maximum when reported. The default output cap is the smaller of 4096 and half the context window.

Every request sends Pi's selected `contextWindow` as `options.num_ctx` and the output limit as `options.num_predict`. Ollama's server-wide context default is therefore superseded for Pi requests. Increasing context consumes more memory; choose a larger value appropriate for your model and machine when working with larger repositories.

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

## Thinking and tools

`--thinking off` sends `think: false` to models that support reasoning. Other supported Pi levels enable thinking. Models such as GPT-OSS use effort values and cannot disable reasoning; their advertised thinking levels reflect that limitation. Thinking and the final answer share the output budget.

Pi preserves native thinking, text, parallel tool calls, tool results, and images across turns. A truncated or failed stream ends as an error, so its tool calls do not execute. Incomplete summaries are not saved as checkpoints.

Discovery does not certify coding ability. Use a tool-capable model and validate its edits and commands; small models and mixed-model histories can produce different results even with identical transport settings.

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

The API identifier is `ollama-chat`. Full API options additionally support `think` and `keepAlive`. Request hooks, custom fetch, cancellation, and HTTP timeouts are supported. The adapter does not automatically replay failed HTTP requests; Pi owns its bounded retry policy.
