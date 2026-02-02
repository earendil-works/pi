# mu-pods

Deploy and manage LLMs on GPU pods with automatic vLLM configuration for agentic workloads.

## Installation

```bash
npm install -g @kennyfrc/mu
```

This package installs the `mu-pods` binary (to avoid clobbering the coding-agent `mu` command).

## What is mu-pods?

`mu-pods` simplifies running large language models on remote GPU pods. It automatically:
- Sets up vLLM on fresh Ubuntu pods
- Configures tool calling for agentic models (Qwen, GPT-OSS, GLM, etc.)
- Manages multiple models on the same pod with "smart" GPU allocation
- Provides OpenAI-compatible API endpoints for each model
- Includes an interactive agent with file system tools for testing

## Quick Start

```bash
# Set required environment variables
export HF_TOKEN=your_huggingface_token      # Get from https://huggingface.co/settings/tokens
export MU_API_KEY=your_api_key              # Any string you want for API authentication

# Setup a DataCrunch pod with NFS storage (models path auto-extracted)
mu-pods pods setup dc1 "ssh root@1.2.3.4" \
  --mount "sudo mount -t nfs -o nconnect=16 nfs.fin-02.datacrunch.io:/your-pseudo /mnt/hf-models"

# Start a model (automatic configuration for known models)
mu-pods start Qwen/Qwen2.5-Coder-32B-Instruct --name qwen

# Send a single message to the model
mu-pods agent qwen "What is the Fibonacci sequence?"

# Interactive chat mode with file system tools
mu-pods agent qwen -i

# Use with any OpenAI-compatible client
export OPENAI_BASE_URL='http://1.2.3.4:8001/v1'
export OPENAI_API_KEY=$MU_API_KEY
```

## Prerequisites

- Node.js 18+
- HuggingFace token (for model downloads)
- GPU pod with:
  - Ubuntu 22.04 or 24.04
  - SSH root access
  - NVIDIA drivers installed
  - Persistent storage for models

## Supported Providers

### Primary Support

**DataCrunch** - Best for shared model storage
- NFS volumes sharable across multiple pods in same region
- Models download once, use everywhere
- Ideal for teams or multiple experiments

**RunPod** - Good persistent storage
- Network volumes persist independently
- Cannot share between running pods simultaneously
- Good for single-pod workflows

### Also Works With
- Vast.ai (volumes locked to specific machine)
- Prime Intellect (no persistent storage)
- AWS EC2 (with EFS setup)
- Any Ubuntu machine with NVIDIA GPUs, CUDA driver, and SSH

## Commands

### Pod Management

```bash
mu-pods pods setup <name> "<ssh>" [options]        # Setup new pod
  --mount "<mount_command>"                   # Run mount command during setup
  --models-path <path>                        # Override extracted path (optional)
  --vllm release|nightly|gpt-oss              # vLLM version (default: release)

mu-pods pods                                       # List all configured pods
mu-pods pods active <name>                         # Switch active pod
mu-pods pods remove <name>                         # Remove pod from local config
mu-pods shell [<name>]                             # SSH into pod
mu-pods ssh [<name>] "<command>"                   # Run command on pod
```

**Note**: When using `--mount`, the models path is automatically extracted from the mount command's target directory. You only need `--models-path` if not using `--mount` or to override the extracted path.

#### vLLM Version Options

- `release` (default): Stable vLLM release, recommended for most users
- `nightly`: Latest vLLM features, needed for newest models like GLM-4.5
- `gpt-oss`: Special build for OpenAI's GPT-OSS models only

### Model Management

```bash
mu-pods start <model> --name <name> [options]  # Start a model
  --memory <percent>      # GPU memory: 30%, 50%, 90% (default: 90%)
  --context <size>        # Context window: 4k, 8k, 16k, 32k, 64k, 128k
  --gpus <count>          # Number of GPUs to use (predefined models only)
  --pod <name>            # Target specific pod (overrides active)
  --vllm <args...>        # Pass custom args directly to vLLM

mu-pods stop [<name>]          # Stop model (or all if no name given)
mu-pods list                   # List running models with status
mu-pods logs <name>            # Stream model logs (tail -f)
```

### Agent & Chat Interface

```bash
mu-pods agent <name> "<message>"               # Single message to model
mu-pods agent <name> "<msg1>" "<msg2>"         # Multiple messages in sequence
mu-pods agent <name> -i                        # Interactive chat mode
mu-pods agent <name> -i -c                     # Continue previous session

# Standalone OpenAI-compatible agent (works with any API)
mu-agent --base-url http://localhost:8000/v1 --model llama-3.1 "Hello"
mu-agent --api-key sk-... "What is 2+2?"  # Uses OpenAI by default
mu-agent --json "What is 2+2?"            # Output event stream as JSONL
mu-agent -i                                # Interactive mode
```

The agent includes tools for file operations (read, list, bash, glob, rg) to test agentic capabilities, particularly useful for code navigation and analysis tasks.

## Predefined Model Configurations

`mu` includes predefined configurations for popular agentic models, so you do not have to specify `--vllm` arguments manually. `mu` will also check if the model you selected can actually run on your pod with respect to the number of GPUs and available VRAM. Run `mu start` without additional arguments to see a list of predefined models that can run on the active pod.

### Qwen Models
```bash
# Qwen2.5-Coder-32B - Excellent coding model, fits on single H100/H200
mu start Qwen/Qwen2.5-Coder-32B-Instruct --name qwen

# Qwen3-Coder-30B - Advanced reasoning with tool use
mu start Qwen/Qwen3-Coder-30B-A3B-Instruct --name qwen3

# Qwen3-Coder-480B - State-of-the-art on 8xH200 (data-parallel mode)
mu start Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8 --name qwen-480b
```

### GPT-OSS Models
```bash
# Requires special vLLM build during setup
mu pods setup gpt-pod "ssh root@1.2.3.4" --models-path /workspace --vllm gpt-oss

# GPT-OSS-20B - Fits on 16GB+ VRAM
mu start openai/gpt-oss-20b --name gpt20

# GPT-OSS-120B - Needs 60GB+ VRAM
mu start openai/gpt-oss-120b --name gpt120
```

### GLM Models
```bash
# GLM-4.5 - Requires 8-16 GPUs, includes thinking mode
mu start zai-org/GLM-4.5 --name glm

# GLM-4.5-Air - Smaller version, 1-2 GPUs
mu start zai-org/GLM-4.5-Air --name glm-air
```

### Custom Models with --vllm

For models not in the predefined list, use `--vllm` to pass arguments directly to vLLM:

```bash
# DeepSeek with custom settings
mu start deepseek-ai/DeepSeek-V3 --name deepseek --vllm \
  --tensor-parallel-size 4 --trust-remote-code

# Mistral with pipeline parallelism
mu start mistralai/Mixtral-8x22B-Instruct-v0.1 --name mixtral --vllm \
  --tensor-parallel-size 8 --pipeline-parallel-size 2

# Any model with specific tool parser
mu start some/model --name mymodel --vllm \
  --tool-call-parser hermes --enable-auto-tool-choice
```

## DataCrunch Setup

DataCrunch offers the best experience with shared NFS storage across pods:

### 1. Create Shared Filesystem (SFS)
- Go to DataCrunch dashboard → Storage → Create SFS
- Choose size and datacenter
- Note the mount command (e.g., `sudo mount -t nfs -o nconnect=16 nfs.fin-02.datacrunch.io:/hf-models-fin02-8ac1bab7 /mnt/hf-models-fin02`)

### 2. Create GPU Instance
- Create instance in same datacenter as SFS
- Share the SFS with the instance
- Get SSH command from dashboard

### 3. Setup with mu
```bash
# Get mount command from DataCrunch dashboard
mu pods setup dc1 "ssh root@instance.datacrunch.io" \
  --mount "sudo mount -t nfs -o nconnect=16 nfs.fin-02.datacrunch.io:/your-pseudo /mnt/hf-models"

# Models automatically stored in /mnt/hf-models (extracted from mount command)
```

### 4. Benefits
- Models persist across instance restarts
- Share models between multiple instances in same datacenter
- Download once, use everywhere
- Pay only for storage, not compute time during downloads

## RunPod Setup

RunPod offers good persistent storage with network volumes:

### 1. Create Network Volume (optional)
- Go to RunPod dashboard → Storage → Create Network Volume
- Choose size and region

### 2. Create GPU Pod
- Select "Network Volume" during pod creation (if using)
- Attach your volume to `/runpod-volume`
- Get SSH command from pod details

### 3. Setup with mu
```bash
# With network volume
mu pods setup runpod "ssh root@pod.runpod.io" --models-path /runpod-volume

# Or use workspace (persists with pod but not shareable)
mu pods setup runpod "ssh root@pod.runpod.io" --models-path /workspace
```


## Multi-GPU Support

### Automatic GPU Assignment
When running multiple models, mu automatically assigns them to different GPUs:
```bash
mu start model1 --name m1  # Auto-assigns to GPU 0
mu start model2 --name m2  # Auto-assigns to GPU 1
mu start model3 --name m3  # Auto-assigns to GPU 2
```

### Specify GPU Count for Predefined Models
For predefined models with multiple configurations, use `--gpus` to control GPU usage:
```bash
# Run Qwen on 1 GPU instead of all available
mu start Qwen/Qwen2.5-Coder-32B-Instruct --name qwen --gpus 1

# Run GLM-4.5 on 8 GPUs (if it has an 8-GPU config)
mu start zai-org/GLM-4.5 --name glm --gpus 8
```

If the model doesn't have a configuration for the requested GPU count, you'll see available options.

### Tensor Parallelism for Large Models
For models that don't fit on a single GPU:
```bash
# Use all available GPUs
mu start meta-llama/Llama-3.1-70B-Instruct --name llama70b --vllm \
  --tensor-parallel-size 4

# Specific GPU count
mu start Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8 --name qwen480 --vllm \
  --data-parallel-size 8 --enable-expert-parallel
```

## API Integration

All models expose OpenAI-compatible endpoints:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://your-pod-ip:8001/v1",
    api_key="your-pi-api-key"
)

# Chat completion with tool calling
response = client.chat.completions.create(
    model="Qwen/Qwen2.5-Coder-32B-Instruct",
    messages=[
        {"role": "user", "content": "Write a Python function to calculate fibonacci"}
    ],
    tools=[{
        "type": "function",
        "function": {
            "name": "execute_code",
            "description": "Execute Python code",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {"type": "string"}
                },
                "required": ["code"]
            }
        }
    }],
    tool_choice="auto"
)
```

## Standalone Agent CLI

`mu` includes a standalone OpenAI-compatible agent that can work with any API:

```bash
# Install globally to get mu-agent command
npm install -g @kennyfrc/mu

# Use with OpenAI
mu-agent --api-key sk-... "What is machine learning?"

# Use with local vLLM
mu-agent --base-url http://localhost:8000/v1 \
         --model meta-llama/Llama-3.1-8B-Instruct \
         --api-key dummy \
         "Explain quantum computing"

# Interactive mode
mu-agent -i

# Continue previous session
mu-agent --continue "Follow up question"

# Custom system prompt
mu-agent --system-prompt "You are a Python expert" "Write a web scraper"

# Use responses API (for GPT-OSS models)
mu-agent --api responses --model openai/gpt-oss-20b "Hello"
```

The agent supports:
- Session persistence across conversations
- Interactive TUI mode with syntax highlighting
- File system tools (read, list, bash, glob, rg) for code navigation
- Both Chat Completions and Responses API formats
- Custom system prompts

## Tool Calling Support

`mu` automatically configures appropriate tool calling parsers for known models:

- **Qwen models**: `hermes` parser (Qwen3-Coder uses `qwen3_coder`)
- **GLM models**: `glm4_moe` parser with reasoning support
- **GPT-OSS models**: Uses `/v1/responses` endpoint, as tool calling (function calling in OpenAI parlance) is currently a [WIP with the `v1/chat/completions` endpoint](https://docs.vllm.ai/projects/recipes/en/latest/OpenAI/GPT-OSS.html#tool-use).
- **Custom models**: Specify with `--vllm --tool-call-parser <parser> --enable-auto-tool-choice`

To disable tool calling:
```bash
mu start model --name mymodel --vllm --disable-tool-call-parser
```

## Memory and Context Management

### GPU Memory Allocation
Controls how much GPU memory vLLM pre-allocates:
- `--memory 30%`: High concurrency, limited context
- `--memory 50%`: Balanced (default)
- `--memory 90%`: Maximum context, low concurrency

### Context Window
Sets maximum input + output tokens:
- `--context 4k`: 4,096 tokens total
- `--context 32k`: 32,768 tokens total
- `--context 128k`: 131,072 tokens total

Example for coding workload:
```bash
# Large context for code analysis, moderate concurrency
mu start Qwen/Qwen2.5-Coder-32B-Instruct --name coder \
  --context 64k --memory 70%
```

**Note**: When using `--vllm`, the `--memory`, `--context`, and `--gpus` parameters are ignored. You'll see a warning if you try to use them together.

## Session Persistence

The interactive agent mode (`-i`) saves sessions for each project directory:

```bash
# Start new session
mu agent qwen -i

# Continue previous session (maintains chat history)
mu agent qwen -i -c
```

Sessions are stored in `~/.mu/sessions/` organized by project path and include:
- Complete conversation history
- Tool call results
- Token usage statistics

## Architecture & Event System

The agent uses a unified event-based architecture where all interactions flow through `AgentEvent` types. This enables:
- Consistent UI rendering across console and TUI modes
- Session recording and replay
- Clean separation between API calls and UI updates
- JSON output mode for programmatic integration

Events are automatically converted to the appropriate API format (Chat Completions or Responses) based on the model type.

### JSON Output Mode

Use `--json` flag to output the event stream as JSONL (JSON Lines) for programmatic consumption:
```bash
mu-agent --api-key sk-... --json "What is 2+2?"
```

Each line is a complete JSON object representing an event:
```jsonl
{"type":"user_message","text":"What is 2+2?"}
{"type":"assistant_start"}
{"type":"assistant_message","text":"2 + 2 = 4"}
{"type":"token_usage","inputTokens":10,"outputTokens":5,"totalTokens":15,"cacheReadTokens":0,"cacheWriteTokens":0}
```

## Troubleshooting

### OOM (Out of Memory) Errors
- Reduce `--memory` percentage
- Use smaller model or quantized version (FP8)
- Reduce `--context` size

### Model Won't Start
```bash
# Check GPU usage
mu ssh "nvidia-smi"

# Check if port is in use
mu list

# Force stop all models
mu stop
```

### Tool Calling Issues
- Not all models support tool calling reliably
- Try different parser: `--vllm --tool-call-parser mistral`
- Or disable: `--vllm --disable-tool-call-parser`

### Access Denied for Models
Some models (Llama, Mistral) require HuggingFace access approval. Visit the model page and click "Request access".

### vLLM Build Issues
If using `--vllm nightly` fails, try:
- Use `--vllm release` for stable version
- Check CUDA compatibility with `mu ssh "nvidia-smi"`

### Agent Not Finding Messages
If the agent shows configuration instead of your message, ensure quotes around messages with special characters:
```bash
# Good
mu agent qwen "What is this file about?"

# Bad (shell might interpret special chars)
mu agent qwen What is this file about?
```

## Advanced Usage

### Working with Multiple Pods
```bash
# Override active pod for any command
mu start model --name test --pod dev-pod
mu list --pod prod-pod
mu stop test --pod dev-pod
```

### Custom vLLM Arguments
```bash
# Pass any vLLM argument after --vllm
mu start model --name custom --vllm \
  --quantization awq \
  --enable-prefix-caching \
  --max-num-seqs 256 \
  --gpu-memory-utilization 0.95
```

### Monitoring
```bash
# Watch GPU utilization
mu ssh "watch -n 1 nvidia-smi"

# Check model downloads
mu ssh "du -sh ~/.cache/huggingface/hub/*"

# View all logs
mu ssh "ls -la ~/.vllm_logs/"

# Check agent session history
ls -la ~/.mu/sessions/
```

## Environment Variables

- `HF_TOKEN` - HuggingFace token for model downloads
- `MU_API_KEY` - API key for vLLM endpoints
- `MU_CONFIG_DIR` - Config directory (default: `~/.mu`)
- `OPENAI_API_KEY` - Used by `mu-agent` when no `--api-key` provided

## License

MIT
