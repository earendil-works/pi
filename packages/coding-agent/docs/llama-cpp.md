# Local Models with llama.cpp

Pi supports the [llama.cpp](https://github.com/ggml-org/llama.cpp) router server. The router discovers multiple GGUF models and loads or unloads them on demand.

Use a current llama.cpp build with router support. Follow the [build instructions](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md) or install a [prebuilt release](https://github.com/ggml-org/llama.cpp/releases) for your platform.

Pi can reach llama.cpp in two ways:

- **Managed:** Pi starts `llama-server` when a llama.cpp model is first used and stops it when no Pi process uses it anymore. Use this unless you already run a server.
- **Connect:** Pi connects to a router you start and manage yourself, for example on another machine or shared with other clients.

## Managed server

Install llama.cpp so that `llama-server` is on your `PATH`, then run:

```text
/login llama.cpp
```

Select **Start llama-server automatically**. Pi checks that `llama-server --version` runs and stores the choice. It does not start the server yet.

The server starts the first time a llama.cpp model is used or `/llama` is opened. Pi binds it to `127.0.0.1` on a random free port and protects it with a random API key, so it never conflicts with other servers and is not reachable from other machines. All Pi processes share one server. After the last Pi process exits, the server keeps running for `llamaCpp.idleShutdownSeconds` (30 seconds by default) and then stops. A Pi process started in that window reuses the running server and its loaded models.

Models come from `~/.pi/agent/llama/models` and from the llama.cpp download cache. Put GGUF files in the models directory using the layout described in [Connect to a router](#connect-to-a-router), or download models with `/llama`. Downloads go to the llama.cpp Hugging Face cache (`~/.cache/huggingface/hub` by default, or `LLAMA_CACHE`, `HF_HUB_CACHE`, or `HF_HOME` when set). `/llama` shows both directories.

All models in the managed server appear in `/model` and load when selected, unless `llamaCpp.args` contains `--no-models-autoload`. The request waits while the model loads. Pi reads the model list only from a running server and remembers it, so starting Pi does not start the server. Right after `/login`, open `/llama` once to populate `/model`.

### Settings

Configure the managed server in `~/.pi/agent/settings.json`. Project settings cannot change it because it selects a command to run.

```json
{
  "llamaCpp": {
    "command": "llama-server",
    "modelsDir": "~/models",
    "args": ["--jinja", "-ngl", "999", "-c", "32768"],
    "idleShutdownSeconds": 30
  }
}
```

| Setting | Default | Description |
|---|---|---|
| `command` | `llama-server` | Executable to run. Supports a leading `~`. |
| `modelsDir` | `~/.pi/agent/llama/models` | Directory with local GGUF files. Supports a leading `~`. |
| `args` | `[]` | Extra `llama-server` arguments, such as `-c` or `--models-preset`. `--host`, `--port`, `--api-key`, `--models-dir`, and single-model options (`-m`, `-hf`, ...) are rejected because Pi controls them. |
| `idleShutdownSeconds` | `30` | How long the server keeps running after the last Pi process exits. `0` stops it right away. |

Settings apply when the server starts. After changing them, choose **Restart server** in `/llama`. Restarting unloads all models and interrupts requests from other Pi processes.

The server inherits the environment of the Pi process that started it. If `HF_TOKEN` is not set, Pi passes the Hugging Face token it finds (see [Manage models](#manage-models)) so gated downloads work.

### Logs

The server writes to `~/.pi/agent/llama/server.log`, which starts fresh each time a new server starts. Choose **View log** in `/llama` to see the last lines. If the server fails to start, the error in Pi names the log file.

## Connect to a router

Start `llama-server` without `--model` or `-m`. Passing a model starts single-model mode instead of router mode.

```bash
llama-server \
  --models-dir ~/models \
  --no-models-autoload \
  --jinja \
  --host 127.0.0.1 \
  --port 8080 \
  -ngl 999 \
  -c 32768
```

Important options:

- `--models-dir ~/models` discovers local GGUF files.
- `--no-models-autoload` keeps loading explicit through `/llama`.
- `--jinja` enables compatible chat templates and tool calling.
- `-ngl 999` offloads as many layers as possible to the GPU.
- `-c 32768` sets the context window for each loaded model. Omit it to use the model's native context, which may require substantially more memory.

A single-file model can sit directly in the model directory. Put multimodal and multi-shard models in separate subdirectories:

```text
~/models/
├── llama-3.2-1b-Q4_K_M.gguf
├── gemma-3-4b-it-Q4_K_M/
│   ├── gemma-3-4b-it-Q4_K_M.gguf
│   └── mmproj-F16.gguf
└── large-model-Q4_K_M/
    ├── large-model-Q4_K_M-00001-of-00003.gguf
    ├── large-model-Q4_K_M-00002-of-00003.gguf
    └── large-model-Q4_K_M-00003-of-00003.gguf
```

Restart the router after manually adding files. For per-model context sizes and other options, use [llama.cpp model presets](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#model-presets).

Start Pi and configure the provider:

```text
/login llama.cpp
```

Select **Connect to a running server**, then enter the router URL and optional API key. The default URL is `http://127.0.0.1:8080`.

If you start the router with `--no-models-autoload`, `/login llama.cpp` only stores the connection. Run `/llama` to load a model, then `/model` to select the loaded model for the current session.

Environment variables can configure the same values without `/login`:

```bash
export LLAMA_BASE_URL=http://127.0.0.1:8080
export LLAMA_API_KEY=optional-secret
pi
```

If the server uses an API key, start `llama-server` with the matching `--api-key` value. Keep `--host 127.0.0.1` for local-only access.

## Manage models

Run:

```text
/llama
```

- Select an unloaded model to load it.
- Select a loaded model to unload it.
- Select **Download model…**, search Hugging Face, then choose a repository and quantization. Exact `owner/repository[:quant]` values also work.
- Press Escape during a load or download to confirm cancellation.

With a managed server, `/llama` also shows the models and download directories and offers **Restart server** and **View log**.

Hugging Face search uses `HF_TOKEN` when set, then checks `$HF_TOKEN_PATH`, `$HF_HOME/token`, `$XDG_CACHE_HOME/huggingface/token`, and `~/.cache/huggingface/token`. Search also works without authentication, subject to lower rate limits. Pi warns before downloading gated repositories and links to their access page. The llama.cpp server performs the download, so its process must also have `HF_TOKEN` when the selected repository requires access.

If other models are loaded, Pi asks whether to unload them first or keep them loaded. Pi does not silently unload models and never deletes model files. The router may be shared with other clients, so `/llama` always displays the router's current state.

Loaded and sleeping models appear in `/model`. Sleeping models wake automatically when selected. With router autoload enabled, unloaded preset models also appear and load when selected; with a managed server, all unloaded models do. With `--no-models-autoload`, load a model through `/llama` before selecting it.

If the router disconnects, `/llama` shows **Retry** and **Close**. Retry reconnects and refreshes model state without replaying the interrupted operation.

## Classification

Every model listed for chat is also listed as a classifier model with the same ID and the `llama-cpp-classify` API. Classifier models answer typed `choice`, `bool`, and `score` questions about JSON state, like TypeSafe's Jev models. The model reaches them from [`codemode`](cli.md#enable-codemode) scripts, and extensions through `ctx.modelRegistry.classify()`; see [Classifier models](models.md#use-classifier-models).

The model does not generate an answer. Each question becomes one chat prompt: the state, every question of the request, the state again, and then the question with its answers under single-token labels. Labels are letters for a choice (up to 62 options), `Yes`/`No` for a bool, and digits for a score (up to 10 levels). The second copy of the state is read with the questions in view, which improved accuracy on JevBench with small models. Pi reads the probabilities of the labels as the next token and normalizes them. A choice returns every option's probability and a confidence of `(n * peak - 1) / (n - 1)`; a score returns the expected level.

- Raw label probabilities are usually overconfident. The per-request `temperature` option divides the label logits before normalizing; values above 1 soften the distribution. It changes no answer.
- Questions run one after another. Everything before the final question is the same for all questions of a request, so the server's prompt cache evaluates it once. The state appears twice, so it needs twice its size in context.
- Small models may follow instructions written inside the state. The prompt tells the model to judge the state as data, but that is not a guarantee.
- Hybrid models such as Qwen3.5 cannot rewind a partially cached prompt without context checkpoints. If each question reprocesses the whole state, start the router with `--ctx-checkpoints 32 --checkpoint-min-step 0`.

## Troubleshooting

For a managed server:

- **`/login` cannot find `llama-server`:** Install llama.cpp or set `llamaCpp.command` to the full path.
- **The server fails to start:** Read `~/.pi/agent/llama/server.log`. Invalid `llamaCpp.args` usually show up there.
- **Models missing after adding files:** Choose **Restart server** in `/llama`.
- **Server is still running:** It stops `llamaCpp.idleShutdownSeconds` after the last Pi process exits. If a supervisor process was killed with `SIGKILL`, `llama-server` may keep running; stop it manually.

For a router you started, check that it is reachable:

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/models
```

- **No models in `/llama`:** Check `--models-dir`, the directory layout, and restart the router.
- **Model missing from `/model` with `--no-models-autoload`:** Load it with `/llama` first.
- **Load fails or uses too much memory:** Lower `-c` or unload another model.
- **Server is not in router mode:** Start it without `--model`, `-m`, or `-hf`.

To remove the `llama.cpp` provider and `/llama`, disable `llama.cpp` under Built-in in `pi config`, or set `"extensions": ["-builtin:llama.cpp"]` in [settings](settings.md#resources).
