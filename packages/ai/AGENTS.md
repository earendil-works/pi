# web-ui — Browser UI components for AI chat

## OVERVIEW
Web components for AI chat interfaces using mini-lit, Tailwind CSS, and IndexedDB storage.

## STRUCTURE
```
src/
  ChatPanel.ts           — Top-level: agent + artifacts layout
  index.ts               — Barrel exports
  components/            — LitElement web components
    sandbox/             — Iframe runtime providers
  dialogs/               — Modal components
  storage/               — IndexedDB persistence
    store.ts             — Abstract Store base
    backends/            — IndexedDB implementation
    stores/              — Sessions, settings, provider keys
  tools/                 — Tool rendering system
    artifacts/           — HTML, SVG, PDF, Markdown, etc.
    renderers/           — Bash, Calculate, Default, etc.
  utils/
    i18n.ts              — Translations (EN/DE)
    attachment-utils.ts  — File loading, MIME detection
example/                 — Standalone demo app
```

## WHERE TO LOOK
| Task | Start |
|------|-------|
| New UI component | `src/components/` — extend LitElement, `@customElement("pi-*")` |
| New dialog | `src/dialogs/` |
| New tool renderer | Implement `ToolRenderer` in `src/tools/renderers/`, register in `renderer-registry.ts` |
| New artifact type | `src/tools/artifacts/` |
| New storage store | Extend `Store` in `src/storage/stores/` |
| Add translatable string | `src/utils/i18n.ts` — add to both `en` and `de` |
| Sandbox runtime | `src/components/sandbox/` |

## CONVENTIONS
- Components use `@mariozechner/mini-lit` with `@customElement("pi-*")` decorator.
- CSS lives in `src/app.css`, compiled by Tailwind CLI.
- Registries (tools, messages) use register/get/render pattern — no static imports of implementations.
- Storage uses abstract `Store` base with `StorageBackend`; IndexedDB is the only backend.
- Build uses standard `tsc` (not tsgo) with `experimentalDecorators: true`.
- Check script: `biome check --write --error-on-warnings . && tsc --noEmit`.
- Every public symbol re-exported from `src/index.ts`.

## ANTI-PATTERNS
- Do not import `lit` directly for base classes — use `@mariozechner/mini-lit`.
- Do not create per-component CSS files — all styles via Tailwind in `app.css` or inline.
- Do not hardcode English strings — add entries to `i18n.ts`.
- Do not register tools/renderers at module top-level — use registry functions.
- Do not add storage logic outside `storage/` directory.
- Do not use `useDefineForClassFields: true` — Lit decorators require `false`.
