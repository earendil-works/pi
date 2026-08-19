# Environment Variables

Pi uses environment variables in three ways:

- Variables such as `SPI_OFFLINE` configure the Pi process.
- Pi sets process markers so child processes can identify Pi as the launching agent.
- Commands run by the LLM-callable bash tool receive `PI_*` variables describing the current session.

Provider API-key variables are documented separately in [Providers](providers.md#environment-variables-or-auth-file).

## Process Marker

The CLI and RPC entry points set two process markers:

- `AI_AGENT=pi` is a generic marker that lets tooling identify Pi as the agent that launched the process.
- `SPI_CODING_AGENT=true` is Pi-specific and lets child processes detect that they run inside Pi.

Child processes inherit both markers. They are not session-specific and are not set automatically when Pi is embedded through the SDK.

## Bash Tool Session Environment

Commands run by the bash tool receive the current Pi session state:

| Variable | Description |
|----------|-------------|
| `SPI_SESSION_ID` | Current session ID |
| `SPI_SESSION_FILE` | Absolute path to the current session JSONL file; unset for ephemeral sessions |
| `SPI_PROVIDER` | Currently selected model provider |
| `SPI_MODEL` | Currently selected model ID |
| `SPI_REASONING_LEVEL` | Current effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

The values are resolved when each command starts. Switching models or changing the reasoning level therefore affects the next bash command without restarting Pi. `SPI_PROVIDER` and `SPI_MODEL` identify the selected Pi model, not a different upstream model that a router may choose internally.

When asked which model or provider is running, inspect these variables instead of inferring the answer from the system prompt:

```bash
printf '%s/%s\n' "$SPI_PROVIDER" "$SPI_MODEL"
printf 'reasoning=%s session=%s\n' "$SPI_REASONING_LEVEL" "$SPI_SESSION_ID"
```

The session file can be inspected directly when the session is persistent:

```bash
if [ -n "$SPI_SESSION_FILE" ]; then
  tail -n 1 "$SPI_SESSION_FILE"
fi
```

These variables are injected into the LLM-callable bash tool. They are not injected into user-entered `!` or `!!` commands.

### Custom Bash Tools

Bash tools created with `createBashTool()` expose the session environment by default when registered with Pi. Injection happens before `spawnHook`, so a hook receives the variables in `ctx.env`:

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

Disable session metadata independently of the spawn hook:

```typescript
const bashTool = createBashTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

When disabled, Pi removes inherited values for these variables so nested Pi processes do not expose stale parent-session metadata.

## Pi Process Configuration

These variables are read by Pi itself:

| Variable | Description |
|----------|-------------|
| `SPI_CODING_AGENT_DIR` | Override the config directory; default is `~/.spi/agent` |
| `SPI_CODING_AGENT_SESSION_DIR` | Override session storage; overridden by `--session-dir` |
| `SPI_PACKAGE_DIR` | Override the package directory, useful for Nix/Guix store paths |
| `SPI_OFFLINE` | Disable startup network operations, including update checks, package updates, and install/update telemetry |
| `SPI_SKIP_VERSION_CHECK` | Disable the `pi.dev` latest-version request |
| `SPI_TELEMETRY` | Override install/update telemetry and provider attribution headers: `1`/`true`/`yes` or `0`/`false`/`no` |
| `SPI_CACHE_RETENTION` | Set to `long` for extended provider prompt caching where supported |
| `SPI_SHARE_VIEWER_URL` | Override the base URL used by `/share` |
| `SPI_HARDWARE_CURSOR` | Set to `1` to show the hardware cursor; see [Terminal setup](terminal-setup.md) |
| `SPI_TUI_ESC_TIMEOUT` | How long to wait after a lone ESC before treating it as Escape, in milliseconds; defaults to `100` over SSH and `10` otherwise. Increase if Alt-key input is misread as Escape |
| `VISUAL`, `EDITOR` | External editor fallback when `externalEditor` is unset |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests |

Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and cloud-provider configuration are listed in [Providers](providers.md#environment-variables-or-auth-file).
