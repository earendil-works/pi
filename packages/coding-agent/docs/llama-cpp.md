# Local Models with llama.cpp

Pi supports the [llama.cpp](https://llama.app) router server. The router discovers multiple GGUF models and loads or unloads them on demand.

## Install llama.cpp

You can easily install llama.cpp on your machine:

- **Mac and Windows**: install the [Llama app](https://llama.app), a minimalist desktop app that sits on your system tray
- **Linux (or if you only want the command line)**: one-line install command:

```bash
curl -LsSf https://llama.app/install.sh | sh
```

Verify the installation:

```bash
llama --version
```

See the [official install page](https://llama.app/docs/installation) for other installation methods, including package managers and building from source.

## Start the router

If you installed the desktop app, `llama serve` is already running. You can check by browsing the model list on [localhost:9931](http://localhost:9931/v1/models).

If not, start `llama serve` without `--model`, `-m`, or `-hf`. Passing a model starts single-model mode instead of router mode. See the [llama.cpp server guide](https://llama.app/docs/serve#serving-multiple-models-router-mode) for router configuration.

You have two options:
- Automatic loading: by default, models load on demand.
- Manual loading: add `--no-models-autoload`, then use `/llama` to load models before selecting them.

For automatic loading, just launch:

```bash
llama serve
```

In most cases you do not need any extra flags as the defaults should be reasonable. For advanced usage, here are a sample of possible flags you might be interested in:

- `-ngl all` offloads all layers to the GPU. Omit it to use automatic GPU offloading.
- `-c 32768` sets the context size in tokens. Use `-c 0` for the model's full context window, which may require substantially more memory. Context is shared across parallel server slots.
- `--models-dir ~/models` discovers local GGUF files from a custom local directory.

By default, models will be stored in the standard huggingface local cache directory. Multimodal and multi-shard models are supported out of the box:

```text
~/.cache/huggingface/hub/
├── llama-3.2-1b-Q4_K_M.gguf
├── gemma-3-4b-it-Q4_K_M/
│   ├── gemma-3-4b-it-Q4_K_M.gguf
│   └── mmproj-F16.gguf
└── large-model-Q4_K_M/
    ├── large-model-Q4_K_M-00001-of-00003.gguf
    ├── large-model-Q4_K_M-00002-of-00003.gguf
    └── large-model-Q4_K_M-00003-of-00003.gguf
```

The router also supports cached models and preset files via `--models-preset`, as described in the [server guide](https://llama.app/docs/serve#serving-multiple-models-router-mode).

If you prefer manual loading, add `--no-models-autoload` to the `llama serve` command and use Pi's `/llama` command to load or unload models.

## Configure Pi

Start Pi and configure the provider:

```text
/login llama.cpp
```

Enter the router URL and optional API key. The default URL is `http://127.0.0.1:9931`.

Use `/model` to select a model for the current session. If you disabled automatic loading, load it with `/llama` first.

Environment variables can configure the same values without `/login`:

```bash
export LLAMA_BASE_URL=http://127.0.0.1:9931
export LLAMA_API_KEY=optional-secret
pi
```

If the server uses an API key, start `llama serve` with the matching `--api-key` value. Keep `--host 127.0.0.1` for local-only access.

## Manage models

Run:

```text
/llama
```

- Select an unloaded model to load it.
- Select a loaded model to unload it.
- Select **Download model…**, search Hugging Face, then choose a repository and quantization. Exact `owner/repository[:quant]` values also work.
- Press Escape during a load or download to confirm cancellation.

Hugging Face search uses `HF_TOKEN` when set, then checks `$HF_TOKEN_PATH`, `$HF_HOME/token`, `$XDG_CACHE_HOME/huggingface/token`, and `~/.cache/huggingface/token`. Search also works without authentication, subject to lower rate limits. Pi warns before downloading gated repositories and links to their access page. The llama.cpp server performs the download, so its process must also have `HF_TOKEN` when the selected repository requires access.

If other models are loaded, Pi asks whether to unload them first or keep them loaded. Pi does not silently unload models and never deletes model files. The router may be shared with other clients, so `/llama` always displays the router's current state.

Loaded and sleeping models appear in `/model`. Sleeping models wake automatically when selected. With router autoload enabled, unloaded preset models also appear and load on demand.

If the router disconnects, `/llama` shows **Retry** and **Close**. Retry reconnects and refreshes model state without replaying the interrupted operation.

## Classification

Classifier models answer typed `choice`, `bool`, and `score` questions about JSON state, like TypeSafe's Jev models. The model reaches them from [`codemode`](cli.md#enable-codemode) scripts, and extensions through `ctx.modelRegistry.classify()`; see [Classifier models](models.md#use-classifier-models). Pi lists llama.cpp models as classifiers in two ways:

- **Decision models** such as [Julia-1, Laya, Kev, lev, and OpenJev](https://huggingface.co/collections/ggml-org/decision-models-6abf80cca3c83f127060a769) answer natively through llama.cpp's `/v1/systemone` endpoint. They appear only as classifiers, with the `typesafe-system-one` API, and not in `/model`.
- **Chat models** are also listed as classifiers with the same ID and the `llama-cpp-classify` API, which reads answers from next-token probabilities as described below.

llama.cpp 0.6.0 and later report decision models in the router's model list: their `architecture.output_modalities` contains `decisions`. The router reads this from the GGUF metadata without loading the model, so Pi recognizes unloaded and sleeping decision models too. Older llama.cpp builds do not report it, and Pi lists their decision models as chat models.

### Chat models as classifiers

The model does not generate an answer. Each question becomes one chat prompt: the state, every question of the request, the state again, and then the question with its answers under single-token labels. Labels are letters for a choice (up to 62 options), `Yes`/`No` for a bool, and digits for a score (up to 10 levels). The second copy of the state is read with the questions in view, which improved accuracy on JevBench with small models. Pi reads the probabilities of the labels as the next token and normalizes them. A choice returns every option's probability and a confidence of `(n * peak - 1) / (n - 1)`; a score returns the expected level.

- Raw label probabilities are usually overconfident. The per-request `temperature` option divides the label logits before normalizing; values above 1 soften the distribution. It changes no answer.
- Questions run one after another. Everything before the final question is the same for all questions of a request, so the server's prompt cache evaluates it once. The state appears twice, so it needs twice its size in context.
- Small models may follow instructions written inside the state. The prompt tells the model to judge the state as data, but that is not a guarantee.
- Hybrid models such as Qwen3.5 cannot rewind a partially cached prompt without context checkpoints. If each question reprocesses the whole state, start the router with `--ctx-checkpoints 32 --checkpoint-min-step 0`.

## Troubleshooting

Check that the router is reachable:

```bash
curl http://127.0.0.1:9931/health
curl http://127.0.0.1:9931/models
```

- **No models in `/llama`:** Check `--models-dir` or the local huggingface cache, the directory layout, and restart the router. Make sure your server URL (http://127.0.0.1:9931) and optional API Key, if you used one, are correct.
- **Model missing from `/model` with `--no-models-autoload`:** Load it with `/llama` first.
- **Load fails or uses too much memory:** Lower `-c` or unload another model.
- **Server is not in router mode:** Start it without `--model`, `-m`, or `-hf`.

To remove the `llama.cpp` provider and `/llama`, disable `llama.cpp` under Built-in in `pi config`, or set `"extensions": ["-builtin:llama.cpp"]` in [settings](settings.md#resources).
