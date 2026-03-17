# packages/pods/src/commands

## Purpose
Command implementations for the pi-pods CLI: pod management, model lifecycle (start/stop/list/logs), and interactive agent sessions.

## Technology
TypeScript. SSH-based remote execution, `chalk` for output.

## Contents
- `pods.ts` - `setupPod()`, `listPods()`, `switchActivePod()`, `removePodCommand()`: pod CRUD operations
- `models.ts` - `startModel()`, `stopModel()`, `stopAllModels()`, `listModels()`, `viewLogs()`, `showKnownModels()`: model lifecycle management via SSH
- `prompt.ts` - `promptModel()`: interactive or scripted agent sessions against running vLLM models

## Key Functions
- `setupPod(name, sshCmd, options?)`: Configure new pod (SSH connection, GPU detection, vLLM install)
- `startModel(modelId, name, options?)`: Start vLLM model on active pod
- `stopModel(name, options?)`: Stop specific model
- `listModels(options?)`: List running models on active pod
- `promptModel(name, agentArgs, options?)`: Start agent session with model

## Data Types
- Pod options: `{ mount?, modelsPath?, vllm? }`
- Model options: `{ pod?, memory?, context?, gpus?, vllmArgs? }`

## Logging
`chalk`-colored console output.

## CRUD Entry Points
- **Create**: `setupPod()` creates pod config, `startModel()` starts model
- **Read**: `listPods()`, `listModels()`, `viewLogs()`
- **Update**: `switchActivePod()`
- **Delete**: `removePodCommand()`, `stopModel()`, `stopAllModels()`

## Style Guide
- Async functions for all SSH operations
- Error messages include actionable instructions
