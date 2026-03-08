# Working Footer XTUI Verification

This is an opt-in verification suite for the TUI layout change that moves the live `Working (...)` status out of the chat body and into the footer.

It uses the real `mu` CLI under `xtui`.

## What it verifies

- Idle layout still shows workspace context below the composer.
- During an active run, the `Working (...)` row is either:
  - **current behavior**: above the composer, inside the chat area
  - **target behavior**: below the composer, in footer chrome

## Harness file

- `packages/coding-agent/test/manual/working-footer-xtui-suite.ts`

## Commands

Validate that the harness matches today's behavior:

```bash
npx tsx packages/coding-agent/test/manual/working-footer-xtui-suite.ts --expect current
```

Run the task acceptance check:

```bash
npx tsx packages/coding-agent/test/manual/working-footer-xtui-suite.ts --expect target
```

## Notes

- The script launches `npx tsx packages/coding-agent/src/cli.ts --no-session` by default.
- It sends one short prompt: `hello`.
- It requires a working `mu` setup in the current shell environment.
- Snapshot artifacts are written to a temporary directory and printed at the end.

## Useful overrides

Use a different prompt:

```bash
npx tsx packages/coding-agent/test/manual/working-footer-xtui-suite.ts --expect target --prompt 'summarize this repo'
```

Use a custom mu launch command:

```bash
npx tsx packages/coding-agent/test/manual/working-footer-xtui-suite.ts \
  --expect target \
  --mu-cmd 'mu --provider openai --model gpt-4o-mini --no-session'
```

Save artifacts in a fixed directory:

```bash
npx tsx packages/coding-agent/test/manual/working-footer-xtui-suite.ts \
  --expect target \
  --out-dir /tmp/mu-working-footer-check
```

## Pass criteria for the task

The task is ready when `--expect target` passes and the active snapshot shows:

- no `Working (...)` row above the composer
- at least one `Working (...)` row below the composer
- idle workspace context still present below the composer
