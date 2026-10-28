# Issue triage

A local tool for the daily issue review. It runs in this order:

1. **Sync.** Keeps a local copy of the repository's issues in `data/corpus.json` with `gh api`. The first run fetches the last 120 days; after that it syncs every 20 minutes and only fetches what changed.
2. **Triage.** Each new issue gets its own conversation with a [pi-durable](../../packages/durable/README.md) agent. The agent:
   - searches the local copy for duplicates and related issues (`search_issues`, `read_issue`)
   - picks a category from `categories/*.md`
   - writes a one-sentence summary and signals
   - suggests p0, p1, or none
3. **Review.** A web UI lists the inbox: every issue created since the inbox start, grouped by the agent's suggestion. You set p0, p1, or none, and fix the category if needed. Each issue links to GitHub.

Decisions are stored locally only. Nothing is written to GitHub yet.

All state lives in `data/` (gitignored):

- `corpus.json`: the local copy of the issues
- `triage.sqlite`: pi-durable storage with one conversation per triaged issue, the triage results, and your decisions in the `triage.state` document
- `token`: the UI access token

Restarting the server resumes any triage runs that were in flight.

## Files

- `categories/*.md`: one file per category. The file name is the category label. The frontmatter `owner` is the GitHub user who owns the category.
- `prompt.md`: the triage procedure and priority guidance given to the agent.
- `main.ts`: sync loop and HTTP server.
- `triage.ts`: the durable triage agent.
- `github.ts`: the local copy of the issues and keyword search.
- `ui.html`: the web UI.
- `source-hooks.mjs`, `register.mjs`: run workspace packages from source, so no build is needed.

## Run

```bash
./scripts/issues/run.sh   # http://127.0.0.1:7788
```

Open `http://127.0.0.1:7788/?t=<token>` once, with the token from `scripts/issues/data/token`. The server then sets a cookie, so later visits don't need the token.

The agent authenticates through `~/.pi/agent/auth.json`, the same credentials pi uses.

| Variable | Default | |
|---|---|---|
| `TRIAGE_MODEL` | `openai-codex/gpt-5.6-sol` | `provider/model`. Supported providers: `openai-codex`, `anthropic`. |
| `TRIAGE_THINKING` | `medium` | Thinking level |
| `TRIAGE_CONCURRENCY` | `4` | Parallel triage runs |
| `TRIAGE_INBOX_DAYS` | `2` | On the first run, the inbox starts this many days back |
| `TRIAGE_CORPUS_DAYS` | `120` | On the first run, fetch issues updated in this many days |
| `TRIAGE_SYNC_MINUTES` | `20` | Sync interval |
| `TRIAGE_PORT` | `7788` | Local port |
| `TRIAGE_SOCKET` | | Listen on this unix socket instead of the port, for a reverse proxy |
| `TRIAGE_DATA` | `scripts/issues/data` | State directory |

## UI keys

- `j`/`k`: move between issues
- `0`, `1`, `n`: set p0, p1, none
- `o`: open the issue on GitHub
