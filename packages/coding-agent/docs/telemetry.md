# Telemetry and Network Requests

Pi contains no analytics or crash-reporting SDK and never uploads a session unless you run a command that does. Without a request from you, Pi contacts only `pi.dev` (an install-and-update ping, a version check, and model catalog updates), the npm registry and git remotes of the Pi packages you configured, and GitHub to download `fd` and `rg` when they are missing. None of these requests contains your prompts, code, credentials, or an identifier for you or your installation.

Pi sends your prompts, conversation history, and tool results to the AI providers of the models you use, and nowhere else unless you run `/share` or `/bug`.

To stop every automatic request, start Pi with `--offline` or set `PI_OFFLINE=1`. See [Turn off network activity](#turn-off-network-activity).

## Automatic requests

| Request | Destination | When | Data sent | Turn off with |
|---|---|---|---|---|
| [Install and update ping](#install-and-update-ping) | `https://pi.dev/api/report-install` | Interactive mode: the first run and the first run after an update | Pi version, `User-Agent` | `PI_TELEMETRY=0`, `enableInstallTelemetry: false`, offline mode |
| [Version check](#version-check) | `https://pi.dev/api/latest-version` | Every interactive-mode start | `User-Agent` | `PI_SKIP_VERSION_CHECK=1`, offline mode |
| [Model catalog update](#model-catalog-updates) | `https://pi.dev/api/models/providers/<provider>` | Interactive-mode and RPC-mode start, `/model`, `/login`; at most every 4 hours per AI provider | AI provider ID, `User-Agent` | offline mode |
| [Package checks](#pi-packages) | npm registry, git remotes | Interactive-mode start, and any start with a configured package missing | Package names, git remote URLs | offline mode |
| [Tool download](#fd-and-rg-downloads) | GitHub releases of `sharkdp/fd` and `BurntSushi/ripgrep` | Interactive-mode start, or first use of the `find` or `grep` tool, when the tool is missing | `User-Agent` on the release lookup | Install `fd` and `rg` yourself, offline mode |

The `User-Agent` names Pi's version, operating system, runtime, and CPU architecture, for example `pi/1.6.1 (darwin; node/v24.11.0; arm64)`. As with any HTTP request, the server also sees your IP address.

Print mode and JSON mode make none of the `pi.dev` requests. They use the model catalog cached by earlier runs.

### Install and update ping

Pi sends one `GET` request with its version as a query parameter, for example `https://pi.dev/api/report-install?version=1.6.1`. The request carries no cookie, ID, or request body.

Pi sends it in interactive mode when it records a new version: on the first run and on the first run after an update with new changelog entries. Pi checks the version only when it starts with a new session; while you resume or continue sessions, the ping waits. A failed request is ignored after 5 seconds.

Turn it off with any of these:

- Set `enableInstallTelemetry` to `false` in [settings](settings.md#updates-telemetry-and-warnings), or turn off **Install telemetry** in `/settings`.
- Set `PI_TELEMETRY=0`. `PI_TELEMETRY` overrides the setting: `1`, `true`, or `yes` turns telemetry on, and any other value turns it off.
- Use offline mode.

The same switch controls the [attribution headers](#requests-to-ai-providers) Pi sends to some AI providers.

### Version check

At every interactive-mode start, Pi requests the latest version from `pi.dev` and shows a notification when a newer version exists. `pi update` makes the same request. Set `PI_SKIP_VERSION_CHECK=1` to skip the check at startup.

### Model catalog updates

Pi ships with a model catalog. To learn about new models and price changes between releases, Pi requests the current catalog of each built-in AI provider from `pi.dev`, for example `https://pi.dev/api/models/providers/anthropic?types=chat,image,classifier`.

Pi requests an AI provider's catalog only when it has credentials configured, from `/login`, `auth.json`, or an environment variable such as `ANTHROPIC_API_KEY`. The request contains the AI provider ID, never the credential, so `pi.dev` can see which built-in AI providers you use.

Pi requests each catalog at most once every 4 hours and revalidates unchanged catalogs with an `If-None-Match` header. `pi update --models` refreshes all catalogs at once. Pi saves the results in `~/.pi/agent/models-store.json` and uses them offline and in print mode.

Two AI providers differ:

- Radius loads its model list from the Radius gateway after you sign in to it.
- OpenRouter also loads the models your key may use from OpenRouter, with your key. Pi refreshes it on every catalog update, without the 4-hour interval. See [OpenRouter](providers.md#openrouter).

### Pi packages

At interactive-mode start, Pi checks the [Pi packages](packages.md) listed in your settings for updates: npm packages through `npm view` against your configured registry, and git packages against their remote. When a configured package is missing, Pi installs it at startup in any mode. Packages loaded with `-e` are checked on every start.

### fd and rg downloads

The `find` tool and path completion use `fd`, and the `grep` tool uses `rg`. When neither your `PATH` nor `~/.pi/agent/bin` contains one of them, Pi downloads the latest release from GitHub into `~/.pi/agent/bin`. To avoid the download, install both tools with your system package manager.

## Requests to AI providers

Pi sends model requests directly to the AI provider's endpoint, or to the base URL you configured in [`models.json`](models.md#configure-a-compatible-endpoint). A model request contains the model context: the system prompt, the conversation history, including file contents and command output that tools read, and the tool definitions. The AI provider's data retention and privacy policies apply to that data.

Pi adds the following to model requests:

| Data | Sent to | Purpose |
|---|---|---|
| `User-Agent` in the format above | Every AI provider | Identifies Pi as the client. A `User-Agent` header in `models.json` overrides it. |
| `HTTP-Referer: https://pi.dev`, `X-OpenRouter-Title: pi`, `X-OpenRouter-Categories: cli-agent` | OpenRouter | App attribution in OpenRouter's rankings |
| `X-BILLING-INVOKE-ORIGIN: Pi` | NVIDIA NIM | App attribution |
| `x-opencode-client: pi` | OpenCode | App attribution |
| Session ID | AI providers whose API implementation supports a prompt-cache key or session header, for example OpenAI's `prompt_cache_key` | Lets the provider reuse its prompt cache and route the requests of a session together |

Attribution headers name Pi, not you. They are sent only while install telemetry is on. The session ID is a UUID that Pi creates for each session; it is not derived from your account or machine.

## Identifiers

Pi creates no user or installation identifier by default. It stores these identifiers only in the listed cases:

| Identifier | Created | Stored in | Sent to |
|---|---|---|---|
| Session ID | For each session | The session file, unless the session is ephemeral | AI providers, as described above |
| `deviceId` | When you first use **Sign in with ChatGPT** for the `openai` provider | `~/.pi/agent/settings.json` | OpenAI, as the agent host ID during sign-in |
| `trackingId` | When you opt in to analytics | `~/.pi/agent/settings.json` | Not sent |

Bug reports leave out `deviceId` and `trackingId`. Extensions can read all three: `deviceId` and `trackingId` through `pi.getSettings()` or the settings file, and the session ID through `ctx.sessionManager`. Commands that tools run receive the session ID as `PI_SESSION_ID`.

## Analytics

The `enableAnalytics` setting is `false` by default. The experimental first-run setup, shown only with `PI_EXPERIMENTAL=1`, asks whether you want to share usage data. Opting in sets `enableAnalytics` to `true` and stores a random `trackingId`.

Pi contains no code that sends analytics. It stores the setting and `trackingId` but does not use them.

## Data you send on request

These commands send data only when you run them:

| Command | Destination | Data |
|---|---|---|
| `/bug` | Radius gateway (`https://radius.pi.dev`), read by the Pi developers at Earendil | Your description, the session ID, Pi version, operating system, terminal, model and AI provider configuration without credentials, settings with secret-looking values removed, loaded extension paths, the names but not the values of `PI_*` environment variables, AI provider error messages from the session, and recent crash records from `~/.pi/agent/crashes.json`. The session transcript or a model-written summary only if you choose it. **Export as Zip** writes the same report to a local file instead. |
| `/share` | Radius, visible to your organization, when you are signed in to Radius; otherwise a secret GitHub gist created with `gh`. The [`sessionShareDestination`](settings.md#sessions-and-context) setting can force either one. | The whole session, including the system prompt and tool definitions |
| `/login`, `pi auth login` | The AI provider's sign-in service | Sign-in requests, such as an OAuth flow |
| `pi install`, `pi update` | npm registry, git remotes, `pi.dev` | Package names and versions |

Before `/bug` uploads anything, it shows what the report contains and asks whether to include the transcript. If you choose a model-written summary instead, Pi first sends the transcript to the current AI provider to write the summary.

## Turn off network activity

| Control | Effect |
|---|---|
| `--offline` or `PI_OFFLINE=1` | Turns off every [automatic request](#automatic-requests) and `/bug` uploads. Pi uses cached model catalogs and installed packages. |
| `PI_TELEMETRY=0` or `"enableInstallTelemetry": false` | Turns off the install and update ping and the attribution headers |
| `PI_SKIP_VERSION_CHECK=1` | Turns off the version check |

Pi does not read `DO_NOT_TRACK`. Use the controls above instead.

Offline mode does not block model requests, MCP servers, `/share`, `/login`, or commands that tools run. To stop all network access, run Pi in an [isolated environment](containerization.md) with restricted networking.

## What Pi's controls do not cover

[Extensions](extensions.md) and [Pi packages](packages.md) run inside the Pi process with your permissions. They can make any network request, and Pi's telemetry settings and offline mode do not restrict them. The same applies to [MCP servers](mcp.md) you connect and to commands the model runs with the `bash` tool. Pi gives extensions no analytics consent signal; `enableAnalytics` is not one. Review extensions and packages before you install them. See [Run Pi safely](security.md).

## Telemetry hooks for embedding applications

`@earendil-works/pi-ai` can report spans and metrics for model requests to a telemetry adapter that an embedding application provides. Without an adapter it does nothing, and the `pi` CLI provides none. See [Telemetry](../../ai/README.md#telemetry) in the `pi-ai` README.
