# paper-audit

Project-local pi extension that audits a mathematics paper as a long-running
background task with on-disk checkpointing.

## Commands

- `/audit-paper <path>` - start a new audit task for a `.md` or `.txt` paper.
  The task runs in a detached Node process so the pi session can exit, crash,
  or be restarted without killing the audit.
- `/tasks` - list recent tasks (newest first).
- `/task-status <id>` - show the current stage, progress, artifacts, and a
  tail of the task log.

## Task lifecycle

Each task produces a folder under `.pi/tasks/<id>/`:

```
.pi/tasks/task-YYYYMMDD-NNN/
  status.json     single source of truth (state, stage, progress, artifacts)
  input.md        verbatim copy of the input file
  extracted.txt   normalized plain text used by every later stage
  outline.json    structural outline (sections, theorems, definitions, notation)
  notes/
    chunk-01.md   per-chunk structured audit notes
    ...
    index.json    machine-readable aggregate of all chunk notes
  report.md       final synthesized audit report
  log.txt         append-only log, one line per checkpoint
```

States: `queued` -> `running` -> `completed` | `failed` | `cancelled`.

Stages: `init` -> `extract-text` -> `build-outline` -> `audit-chunk-01` ->
`audit-chunk-02` -> ... -> `write-report` -> `done`.

The worker writes `status.json` and any new artifact to disk at the end of
every stage, so a crash loses at most the current stage.

## Setup

From the repo root:

```bash
npm install
npm run build   # build @mariozechner/pi-ai so the worker can import it
```

Make sure the provider credentials for the model you want to use are exported
in your shell before you start pi (e.g. `ANTHROPIC_API_KEY=...`). The detached
worker inherits the parent pi session's environment.

### Model selection

The worker picks the model from two environment variables:

- `PI_AUDIT_PROVIDER` - defaults to `anthropic`.
- `PI_AUDIT_MODEL` - defaults to `claude-sonnet-4-5`.

Any provider and model id registered in `@mariozechner/pi-ai` works, provided
the matching API key is present.

## Failure handling

- Invalid path or unsupported extension: `/audit-paper` rejects up front, no
  task folder is created.
- Missing API key: task is marked `failed` with a clear error message, no
  partial artifacts beyond `extracted.txt`.
- Model errors / parse failures: `askJson` retries up to three times, then
  fails the task while leaving every artifact from earlier stages on disk.
- Any uncaught worker error is captured by `worker-entry.mjs`, appended to
  `log.txt`, and recorded in `status.json` as `state: "failed"`.

## Scope notes

This is the MVP described in `pi-mono-paper-audit-mvp-plan.md`. It deliberately
does not cover:

- PDF / OCR input
- Formal proof verification
- Vector-memory-assisted chunk review
- Parallel chunk auditing
- Auto-resume after machine restart

The extension is not exercised by `test.sh`; verification is manual.
