# Models and Providers

For a built-in provider, start with `/login`, then choose a model with `/model`. Use custom model configuration only when Pi does not already include the provider or endpoint you need.

## Choose a connection

| What you have | Recommended setup |
|---|---|
| A supported subscription | Sign in through `/login` |
| A provider API key | Store it through `/login` or set its environment variable |
| A local GGUF model | Connect Pi to the llama.cpp router |
| An OpenAI-, Anthropic-, or Google-compatible endpoint | Add it to `models.json` |
| A provider with a custom protocol or authentication flow | Build or install a provider extension |

See [Provider Authentication](provider-reference.md) for supported subscriptions, credential names, cloud-provider requirements, and resolution order.

## Authenticate

Run `/login` and select a provider. Pi stores credentials in `~/.pi/agent/auth.json`. Run `/logout` to remove stored credentials for a provider.

You can instead provide an API key through the provider's environment variable. This is useful in CI and other environments where Pi should not write credentials. The [Provider Authentication](provider-reference.md) reference lists every supported variable and `auth.json` key.

Keep `auth.json` and any credential commands private. Project settings and extensions can execute inside the Pi process after you trust a project. Review [Security](security.md) before loading configuration from an untrusted directory.

## Select a model

Run `/model` to search available models. The picker shows models whose providers have usable authentication. Press `Ctrl+S` on a model to save it as the default for new sessions.

Run `/thinking` to select the thinking level for the current model. Press `Ctrl+S` there to save the startup level. Pi limits the choices to levels supported by the selected model.

`Ctrl+P` cycles through available models. Use `/scoped-models` to control that cycle and save the selection, or configure model patterns through [Settings](settings-reference.md#model-cycling).

A session records model and thinking-level changes. Resuming the session restores them without changing defaults for new sessions.

## Connect local models

Pi integrates directly with the llama.cpp router. The router discovers GGUF files and loads models on demand. Pi's `/llama` command manages the router, while `/model` selects one of its loaded models.

Follow [Local Models with llama.cpp](llama-cpp.md) for server startup, model layout, downloads, and connection troubleshooting.

For Ollama, LM Studio, vLLM, SGLang, and other compatible servers, add the endpoint and models to `~/.pi/agent/models.json`. See [Custom Models](models.md).

## Add a custom provider

Use `models.json` when the endpoint speaks a protocol Pi already supports. Use an extension when the provider needs custom streaming, model discovery, or authentication behavior.

See [Custom Providers](custom-provider.md) for the extension workflow and [Custom Models](models.md) for the configuration format.

## Resolve common problems

### A model does not appear

Confirm that its provider has usable authentication. Custom models can load from `models.json` but remain unavailable in `/model` until Pi can resolve credentials. For llama.cpp, only models currently loaded by the router appear.

### Authentication works in one shell only

Check whether the key came from an environment variable rather than `auth.json`. Environment variables must be present in the process that starts Pi.

### A subscription opens a browser on a remote machine

Complete the provider's headless authentication flow when available. Some providers let you paste the final redirect URL or authorization code back into Pi. See the provider-specific instructions in [Provider Authentication](provider-reference.md#subscriptions).

### A compatible endpoint rejects requests

Check its API type and compatibility settings in `models.json`. Do not enable compatibility flags based only on the endpoint's advertised protocol. The upstream server must support the corresponding request fields and behavior.
