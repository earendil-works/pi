# packages/coding-agent/src/cli

## Purpose
CLI-specific modules for argument parsing, model listing, session picking, file processing, and configuration selection UI.

## Technology
TypeScript. Uses `chalk` for colored output, `@mariozechner/pi-tui` for interactive selection UIs.

## Contents
- `args.ts` - `parseArgs(args, extensionFlags?)`: CLI argument parser supporting `--model`, `--provider`, `--thinking`, `--tools`, `--session`, `--continue`, `--resume`, `--print`, `--mode`, `--export`, file arguments (`@file`), and extension-defined flags
- `list-models.ts` - `listModels(registry, pattern?)`: Display available models in a formatted table
- `session-picker.ts` - `selectSession(listFn, listAllFn)`: Interactive TUI session picker with fuzzy search
- `file-processor.ts` - `processFileArguments(args, options?)`: Process `@file` arguments, handling images with auto-resize
- `config-selector.ts` - `selectConfig(options)`: Interactive configuration editor for settings

## Key Functions
- `parseArgs(args, extensionFlags?)`: Returns `Args` object with all parsed CLI options
- `printHelp()`: Prints full CLI usage documentation
- `listModels(registry, searchPattern?)`: Lists models matching pattern
- `selectSession(listFn, listAllFn)`: Returns selected session path or undefined

## Data Types
- `Args`: Full CLI argument structure (model, provider, thinking, tools, session flags, mode, messages[], fileArgs[], etc.)

## Logging
Console output via `chalk`.

## CRUD Entry Points
- **Create**: Add new CLI flags in `args.ts`
- **Read**: `parseArgs()` to parse command-line arguments
- **Update**: Modify flag definitions and help text
- **Delete**: Remove flags from parser

## Style Guide
- Long flag names with short aliases (e.g., `--continue` / `-c`)
- Two-pass parsing: first pass for extension discovery, second with extension flags
- Tab indentation
