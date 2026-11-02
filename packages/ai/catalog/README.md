# Model catalog

`node catalog/generate.ts` (`npm run generate-models`) fetches upstream catalogs and writes the built-in model catalog:

- `src/providers/data/<provider>.json`: model values, grouped by API (gitignored)
- `src/providers/<provider>.models.ts` and `src/models.generated.ts`: typed wrappers (committed)
- with `--json-output <dir>`: the public catalog JSON served by pi.dev

## Layout

| Path | Contents |
| --- | --- |
| `sources/` | Upstream fetchers. `models-dev.ts` normalizes the [models.dev v2](https://models.dev/experimental/v2.0/api.json) catalog; OpenRouter, Vercel AI Gateway, NVIDIA NIM, and Radius have their own modules. All sources are fetched before anything is built. |
| `providers/<id>.ts` | One file per built-in provider: where its models come from, its API and base URL, compat defaults, corrections, and models upstream does not list. Register new files in `providers/index.ts`. |
| `families/` | Facts about a model family that hold on every host, such as Claude effort levels or GPT-6 thinking levels. They apply to every provider's models. |
| `define.ts` | `defineProvider()` and the helpers provider files use. |
| `build.ts` | Runs the provider definitions in a fixed order. |

## Build order

For each provider:

1. `models(ctx)` returns its chat models: upstream entries mapped to pi models, data corrections (limits, prices), and authored models. `ctx.providerModels(id)` returns another provider's models from this step, e.g. Azure derives from OpenAI.
2. `compat` defaults for each API are merged under each model's own compat. Then the shared rules run: models.dev effort levels for APIs that send them natively, and the rules in `families/`.
3. `finalize(model, ctx)` applies provider-specific behavior. It runs after the shared rules, so its values win.
4. Image input limits get the default resize profile, then `finalizeAll(models, ctx)` runs cross-model logic such as Anthropic's allowed fallback models.

## Adding a provider

Most providers are a models.dev provider served on one API:

```ts
import { defineProvider, modelsDevModels } from "../define.ts";

export default defineProvider({
	id: "example",
	models: (ctx) =>
		modelsDevModels(ctx, "example", { api: "openai-completions", baseUrl: "https://api.example.com/v1" }),
	compat: { "openai-completions": { supportsStore: false, supportsDeveloperRole: false } },
});
```

`modelsDevModels()` keeps tool-capable chat models and maps names, input modalities, costs (including context tiers), and limits. Use its `include` and `map` options for provider-specific filtering and fields. Prefer fixing wrong upstream data in models.dev; keep local corrections small and say why they exist.

## Checking changes

`npm run diff:model-catalog -- [provider ...]` from the repository root generates the catalog at `HEAD` and in the worktree and prints the JSON differences.
