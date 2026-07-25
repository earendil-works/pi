# Pi evals

Behavioral evaluations for Pi using `vitest-evals`.

The Pi harness in `src/pi-harness.ts` is built on `createHarness` from `vitest-evals/harness`. It drives a real
`createAgentSession` in a temporary workspace and reports the final assistant message, transcript, and token usage.

## Running

From the repository root, run with an explicit provider and model:

```bash
npm run eval -- --provider openai-codex --model gpt-5.4
```

When invoked from a Pi Bash tool, the current session supplies `PI_PROVIDER` and `PI_MODEL`, so this is sufficient:

```bash
npm run eval
```

The runner requires both values and never falls back to another model. Additional arguments are forwarded to Vitest, for example:

```bash
npm run eval -- -t "capital of France"
```

Authentication is resolved by Pi's normal `ModelRuntime`. Subscription-backed providers such as `openai-codex` use credentials from the user's Pi configuration. API-backed providers use their standard environment variables, such as `OPENAI_API_KEY` for `openai`.
