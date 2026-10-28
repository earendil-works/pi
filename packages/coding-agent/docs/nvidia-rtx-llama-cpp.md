# Run Pi with NVIDIA RTX and llama.cpp

[NVIDIA Local AI Inference Recipes](https://nvidia.github.io/local-ai-inference-recipes/index.html) provides llama.cpp settings tuned for specific NVIDIA hardware and models. Each recipe gives a single-model `llama-server` command. Pi works with the llama.cpp router, which can serve and manage several models, so this guide converts the recipe command into a router preset.

The examples below use Windows PowerShell. See [Local Models with llama.cpp](llama-cpp.md) for Pi's complete router and model-management reference.

## Before you begin

1. Open the [recipe catalog](https://nvidia.github.io/local-ai-inference-recipes/index.html), select your hardware, operating system, and model, then choose **llama.cpp**. Check the prerequisites and memory requirements. Keep the recipe's launch command for the conversion below.
2. Install llama.cpp with the recipe's setup instructions. The recipe's settings depend on its build, for example CUDA support or speculative decoding options.
3. Run `llama-server --help` and check that it lists `--models-preset`. Without it, the build cannot load the recipe as a router preset. Use a newer build that still meets the recipe's requirements.
4. Install Pi with the [Quickstart](quickstart.md). On native Windows, also see [Run Pi on Windows](windows.md).

## Convert the recipe to a preset

A preset lists the settings for one or more models. Each section name becomes the model ID shown in Pi. Save the preset next to `llama-server`, or pass its full path when starting the router.

Convert each option from the recipe command into one preset line:

- Remove the leading dashes: `--ctx-size 65536` becomes `ctx-size = 65536`.
- Write options without a value as `true`: `--jinja` becomes `jinja = true`.
- Remove quotes and PowerShell line-continuation backticks around values.
- Leave out `--host` and `--port`. They belong on the router command line.
- Add `load-on-startup = true` so the router loads the model when it starts.
- Replace short model-file options with their long preset keys:

| Recipe option | Preset key |
|---|---|
| `-hf` | `hf-repo` |
| `-hff` | `hf-file` |
| `-hfrd` | `hf-repo-draft` |
| `--spec-draft-model` | `spec-draft-model` |

For example, this recipe command:

```powershell
llama-server.exe -hf "unsloth/Qwen3.8-27B-GGUF" `
  -hff "Qwen3.8-27B-UD-Q4_K_M.gguf" `
  -hfrd "z-lab/Qwen3.8-27B-DFlash2-GGUF" `
  --spec-draft-model "Qwen3.8-27B-DFlash2-Q4_K_M.gguf" `
  --no-mmproj `
  --host 127.0.0.1 `
  --port 9931 `
  --batch-size 4096 `
  --ubatch-size 1024 `
  --ctx-size 65536 `
  --parallel 1 `
  -ngl 999 `
  --jinja `
  --chat-template-kwargs '{"preserve_thinking":true}' `
  --spec-type draft-dflash `
  --spec-draft-n-max 7 `
  --spec-draft-backend-sampling
```

becomes `qwen3.8-27b.ini`:

```ini
version = 1

[qwen3.8-27b]
load-on-startup = true
hf-repo = unsloth/Qwen3.8-27B-GGUF
hf-file = Qwen3.8-27B-UD-Q4_K_M.gguf
hf-repo-draft = z-lab/Qwen3.8-27B-DFlash2-GGUF
spec-draft-model = Qwen3.8-27B-DFlash2-Q4_K_M.gguf
no-mmproj = true
batch-size = 4096
ubatch-size = 1024
ctx-size = 65536
parallel = 1
ngl = 999
jinja = true
chat-template-kwargs = {"preserve_thinking":true}
spec-type = draft-dflash
spec-draft-n-max = 7
spec-draft-backend-sampling = true
```

## Start the router

Open PowerShell in the llama.cpp folder and run:

```powershell
.\llama-server.exe --models-preset qwen3.8-27b.ini --host 127.0.0.1 --port 8080
```

If the recipe requires a Hugging Face token, set `$env:HF_TOKEN` in the same PowerShell window before starting the router. On its first start, the router downloads the model files.

Use the [router health checks](llama-cpp.md#troubleshooting) to confirm that the server is ready. In Windows PowerShell, use `curl.exe` rather than `curl`, which PowerShell maps to a different command. The model is ready when `/models` lists `qwen3.8-27b` with the status `loaded`.

## Use the model in Pi

Follow [Configure Pi](llama-cpp.md#configure-pi) and connect to `http://127.0.0.1:8080`. The preset section name is the model ID, so select `qwen3.8-27b` in `/model` for this example.

NVIDIA recipe memory settings assume that only the selected model uses the GPU. If `/llama` shows other loaded models, unload them before using the recipe model.
