# Morph compaction fixtures

This directory holds the deterministic inputs for the `fixtures-and-probes` mission slice.

## Fixture files

- `visible-history-compaction.json`
  - real visible-history fixture extracted from the workspace session
    `/Users/kennyfrc/.mu/agent/sessions/--Users-kennyfrc-Documents-code-work-pi-mono-kenn-dev--/2026-03-19T11-59-28-534Z_5ac506f0-3754-4bf0-a0d5-3ff73c3d4df3.jsonl`
  - selection rule: first 6 visible messages
  - covers mixed `user` / `assistant` / `toolResult` history with large text blocks and thinking/tool-call content

- `native-replay-required.json`
  - synthetic fixture for the strategy guard where native opaque replay state already exists
  - includes a `__muCompactResponseItem` carrier so later strategy/projection tests can prove Morph is not selected incorrectly

## Generation

Refresh the committed fixture JSON with:

```bash
node devdocs/missions/morph-compaction-control/scripts/generate-fixtures.mjs
```

## Live Morph probes

Materialize the probe scripts required by the spec into `/tmp` with:

```bash
node devdocs/missions/morph-compaction-control/scripts/materialize-live-probes.mjs
```

That writes:

- `/tmp/morph-compaction-control/morph-compaction-probe.mjs`
- `/tmp/morph-compaction-control/morph-verbatim-check.mjs`
- `/tmp/morph-compaction-control/morph-query-compare.mjs`

Run them with `MORPH_API_KEY` available, for example:

```bash
source ~/.bashrc
node /tmp/morph-compaction-control/morph-compaction-probe.mjs
node /tmp/morph-compaction-control/morph-verbatim-check.mjs
node /tmp/morph-compaction-control/morph-query-compare.mjs
```

The probes validate the request shapes already observed in the parent thread:

- `POST /v1/compact` with `{ messages, query, compression_ratio, preserve_recent }`
- `POST /v1/compact` with `{ input, query, compression_ratio, preserve_recent }`
- `POST /v1/responses` with `{ model: "morph-compactor", input, query }`
