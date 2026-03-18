# pods — GPU Pod Manager

CLI for managing vLLM deployments on GPU pods. Binary: `pi-pods`.

## Structure
```
src/
  cli.ts            # CLI entry point, command routing
  config.ts         # Pod configuration (GPU types, model mappings)
  ssh.ts            # SSH connection management to pods
  model-configs.ts  # vLLM model configuration presets
  models.json       # Model catalog
  types.ts          # Pod, deployment, GPU types
  index.ts          # Public API
  commands/         # CLI subcommands
```

## Where to Look
| Task | Location |
|------|----------|
| Add CLI command | `src/commands/` + `src/cli.ts` |
| GPU/model config | `src/model-configs.ts` + `src/config.ts` |
| SSH operations | `src/ssh.ts` |
