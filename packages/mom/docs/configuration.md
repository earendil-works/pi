# Mom runtime configuration

All variables are optional unless noted. **Unset values preserve the original upstream behavior** (verbose Slack tool output, Anthropic + `claude-sonnet-4-5`, no tracked threads, etc.).

## Required for the bot

- `MOM_SLACK_APP_TOKEN` — Socket Mode app token
- `MOM_SLACK_BOT_TOKEN` — Bot user OAuth token

## LLM

| Variable | Default | Description |
|----------|---------|-------------|
| `MOM_LLM_PROVIDER` | `anthropic` | Provider id for `@mariozechner/pi-ai` (e.g. `anthropic`, `github-copilot`). |
| `MOM_LLM_MODEL` | `claude-sonnet-4-5` | Model id for that provider. |

Auth: `~/.pi/mom/auth.json` (via `/login` in the pi tooling) or provider env keys as documented upstream.

## Slack UX

| Variable | Default | Description |
|----------|---------|-------------|
| `MOM_SLACK_QUIET` | off | If `1`/`true`/`yes`: minimal Slack noise (no tool labels, no tool result threads, no thinking in Slack, no assistant mirror to thread, no usage summary in thread, dedupe on; disables compaction/retry channel posts). |
| `MOM_SLACK_REPLY_IN_USER_THREAD` | off | If `1`: first bot message and streaming updates go under the user message thread instead of the channel root. |
| `MOM_TRACK_THREADS` | off | Persist `tracked-threads.json` in the working dir; allow follow-up messages in those threads **without** @mention. |
| `MOM_SLACK_STATUS_REACTIONS` | off | Hourglass on user message while running; then checkmark or x. Requires `reactions:write` on the Slack app. |
| `MOM_SLACK_STATUS_THREAD_MESSAGE` | off | Post “On it!” / “Done” (or stopped) in the user thread. |

### Granular overrides (when not using `MOM_SLACK_QUIET`)

| Variable | Default | Description |
|----------|---------|-------------|
| `MOM_SLACK_POST_TOOL_LABELS` | `1` | Post `_→ label_` on tool start. |
| `MOM_SLACK_POST_TOOL_RESULTS` | `1` | Post tool args/result blocks in thread. |
| `MOM_SLACK_POST_TOOL_ERRORS_TO_CHANNEL` | `1` | Post short tool error to the main bot message area. |
| `MOM_SLACK_POST_THINKING` | `1` | Mirror thinking to Slack. |
| `MOM_SLACK_MIRROR_ASSISTANT_TO_THREAD` | `1` | Duplicate assistant streaming text to thread. |
| `MOM_SLACK_POST_USAGE_SUMMARY` | `1` | Post usage summary in thread after run. |
| `MOM_SLACK_DEDUPE_MESSAGES` | off | Skip duplicate consecutive enqueues per target (main/thread). |
| `MOM_SLACK_POST_COMPACTION_NOTICE` | `1` | Post “Compacting context…” |
| `MOM_SLACK_POST_RETRY_NOTICE` | `1` | Post retry notices. |

## Voice (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `MOM_VOICE_TRANSCRIPTION` | off | If `1`, transcribe audio attachments before the agent runs. |
| `MOM_GROQ_API_KEY` | — | Use Groq Whisper (`whisper-large-v3`). |
| `MOM_OPENAI_API_KEY` | — | Use OpenAI Whisper if Groq not set. |

## Example (quiet + thread + tracked threads + Copilot)

```bash
export MOM_SLACK_APP_TOKEN=xapp-...
export MOM_SLACK_BOT_TOKEN=xoxb-...
export MOM_LLM_PROVIDER=github-copilot
export MOM_LLM_MODEL=claude-sonnet-4.5
export MOM_SLACK_QUIET=1
export MOM_SLACK_REPLY_IN_USER_THREAD=1
export MOM_TRACK_THREADS=1
export MOM_SLACK_STATUS_REACTIONS=1
export MOM_SLACK_STATUS_THREAD_MESSAGE=1
```
