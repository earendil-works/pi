# packages/pods/src

## Purpose
CLI tool for managing vLLM deployments on remote GPU pods. Handles pod setup via SSH, model start/stop lifecycle, log streaming, and interactive agent sessions against self-hosted models.

## Technology
TypeScript, ESM modules. SSH-based remote execution. `chalk` for colored output. Depends on `@mariozechner/pi-agent-core`.

## Contents
- `cli.ts` - CLI entry point: command router for pods, shell, ssh, start, stop, list, logs, agent subcommands
- `config.ts` - `loadConfig()`, `saveConfig()`, `getActivePod()`: manages `~/.pi/pods.json` configuration file
- `types.ts` - Core types: `GPU`, `Model`, `Pod`, `Config`
- `ssh.ts` - `sshExecStream()`: SSH command execution with streaming output
- `model-configs.ts` - Predefined vLLM model configurations with GPU/memory/context presets
- `models.json` - Static model catalog with GPU requirements and context window sizes
- `index.ts` - Barrel export

## Key Functions
- `cli.ts` command handlers: `setupPod()`, `listPods()`, `switchActivePod()`, `removePodCommand()`, `startModel()`, `stopModel()`, `stopAllModels()`, `listModels()`, `viewLogs()`, `promptModel()`
- `loadConfig()`: Load pod configuration from `~/.pi/pods.json`
- `saveConfig(config)`: Persist configuration
- `getActivePod()`: Get currently active pod info
- `sshExecStream(sshCommand, remoteCommand)`: Execute command via SSH and stream output

## Data Types
- `Config`: `{ pods: Record<string, Pod>, active?: string }`
- `Pod`: `{ ssh, gpus: GPU[], models: Record<string, Model>, modelsPath?, vllmVersion? }`
- `GPU`: `{ id, name, memory }`
- `Model`: `{ model, port, gpu: number[], pid }`

## Logging
Console output via `chalk` (green for success, red for errors, gray for info).

## CRUD Entry Points
- **Create**: `pi pods setup <name> "<ssh>"` creates a new pod entry
- **Read**: `pi pods` lists pods, `pi list` lists running models
- **Update**: `pi pods active <name>` switches active pod, `pi start` starts models
- **Delete**: `pi pods remove <name>` removes pod, `pi stop [name]` stops models

## Style Guide
- camelCase for functions/variables, PascalCase for types
- Tab indentation
- CLI command pattern: `switch(command)` with named handlers
- SSH commands built as string arrays
- Environment variables: `HF_TOKEN`, `PI_API_KEY`, `PI_CONFIG_DIR`

```typescript
export interface Pod {
	ssh: string;
	gpus: GPU[];
	models: Record<string, Model>;
	modelsPath?: string;
	vllmVersion?: "release" | "nightly" | "gpt-oss";
}
```
