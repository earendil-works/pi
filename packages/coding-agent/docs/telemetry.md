# Telemetry and Network Requests

Pi contains no analytics or crash-reporting SDK and never uploads a session unless you run a command that does. Besides model requests, Pi makes requests on its own to `pi.dev` (an install-and-update ping, a version check, and model catalog updates), to services you configured (model lists of AI providers, MCP servers, and Pi package sources), and to GitHub to download `fd` and `rg` when they are missing. Requests to `pi.dev` contain no prompts, code, credentials, or identifier for you or your installation. Requests to services you configured use your credentials for that service.

Pi sends model requests, which contain your prompts, conversation history, and tool results, only to the AI providers of the models you use. Tools, MCP servers, and extensions can pass that content on. See [What Pi's controls do not cover](#what-pis-controls-do-not-cover).

To stop the requests to `pi.dev`, package sources, and GitHub, start Pi with `--offline` or set `PI_OFFLINE=1`. Offline mode does not stop model requests or MCP connections. See [Turn off network activity](#turn-off-network-activity).

## Automatic requests

| Request | Destination | When | Data sent | Turn off with |
|---|---|---|---|---|
| [Install and update ping](#install-and-update-ping) | `https://pi.dev/api/report-install` | Interactive mode: the first run and the first run after an update | Pi version, `User-Agent` | `PI_TELEMETRY=0`, `enableInstallTelemetry: false`, offline mode |
| [Version check](#version-check) | `https://pi.dev/api/latest-version` | Every interactive-mode start | `User-Agent` | `PI_SKIP_VERSION_CHECK=1`, offline mode |
| [Model catalog update](#model-catalog-updates) | `https://pi.dev/api/models/providers/<provider>` | Interactive-mode and RPC-mode start, model selection (`/model`, `/scoped-models`), sign-in (`/login`, `pi auth login`) | AI provider ID, `User-Agent` | offline mode |
| [Provider model lists](#provider-model-lists) | OpenRouter, the Radius gateway, a configured llama.cpp server | With model catalog updates | Your credential for that service | offline mode |
| [MCP connections](#mcp-servers) | Enabled MCP servers | Session start | Pi's name and version, configured headers or OAuth token, the working directory if the server asks for it | `--no-mcp`, `"enabled": false` per server |
| [Package checks](#pi-packages) | npm registry, git remotes | Interactive-mode start, and any start that needs to install a configured package | Package names, git remote URLs, your npm and git credentials | offline mode |
| [Tool download](#fd-and-rg-downloads) | GitHub releases of `sharkdp/fd` and `BurntSushi/ripgrep` | Interactive-mode start, or use of the `find` or `grep` tool, when the tool is missing | `User-Agent` on the release lookup | Install `fd` and `rg` yourself, offline mode |

The `User-Agent` names Pi's version, operating system, runtime, and CPU architecture, for example `pi/1.6.1 (darwin; node/v24.11.0; arm64)`. As with any HTTP request, the server also sees the IP address the request comes from.

Print mode and JSON mode make none of the `pi.dev` requests. They use the model catalog cached by earlier runs.

Paths under `~/.pi/agent` on this page move to the directory set by `PI_CODING_AGENT_DIR`.

### Install and update ping

Pi sends one `GET` request with its version as a query parameter, for example `https://pi.dev/api/report-install?version=1.6.1`. The request carries no cookie, ID, or request body.

Pi sends it in interactive mode when it records a new version: on the first run and on the first run after an update with new changelog entries. Pi records the version only when it starts with an empty conversation; while you resume or continue sessions, the ping waits. Pi gives up after 5 seconds, ignores errors, and does not retry.

Turn it off with any of these:

- Set `enableInstallTelemetry` to `false` in [settings](settings.md#updates-telemetry-and-warnings), or turn off **Install telemetry** in `/settings`. The default is `true`.
- Set `PI_TELEMETRY=0`. When set, `PI_TELEMETRY` overrides the setting: `1`, `true`, or `yes` in any letter case turns telemetry on, and any other value, including an empty one, turns it off.
- Use offline mode.

The same switch controls the [attribution headers](#requests-to-ai-providers) Pi sends to some AI providers.

### Version check

At every interactive-mode start, Pi requests the latest version from `pi.dev` and shows a notification when a newer version exists. Setting `PI_SKIP_VERSION_CHECK` to any non-empty value skips this check. `pi update` makes the same request when it updates Pi itself.

### Model catalog updates

Pi ships with a model catalog. To learn about new models and price changes between releases, Pi requests the current catalog of each built-in AI provider from `pi.dev`, for example `https://pi.dev/api/models/providers/anthropic?types=chat,image,classifier`.

Pi requests an AI provider's catalog only when that provider has authentication configured, for example through `/login`, `auth.json`, `models.json`, or an environment variable such as `ANTHROPIC_API_KEY`. The request contains the AI provider ID, never the credential, so `pi.dev` can see which built-in AI providers you have configured.

Pi reuses a cached catalog for 4 hours before requesting it again, and sends `If-None-Match` when it has a cached copy. `pi update --models` forces a refresh, also in offline mode. Pi saves the results in `~/.pi/agent/models-store.json` and uses them offline and in print mode.

### Provider model lists

Some AI providers serve their own model lists. Pi requests them during the same catalog updates, with your credential for that provider:

| AI provider | Request |
|---|---|
| OpenRouter | `/models/user` at the configured base URL, by default `https://openrouter.ai/api/v1`, on every catalog update. Its `pi.dev` catalog is also requested on every update. See [OpenRouter](providers.md#openrouter). |
| Radius | `/v1/config` on the Radius gateway, by default `https://radius.pi.dev` |
| llama.cpp | `/models` on the configured server, and `/props` for each loaded model |

When a stored OAuth token has expired, Pi first refreshes it with the AI provider.

### MCP servers

At session start, Pi connects in the background to every enabled server in your [MCP configuration](mcp.md), also in offline mode. A remote server receives Pi's name and version and any headers or OAuth token you configured, and the working directory if it asks for the client's roots. Start Pi with `--no-mcp` to connect to no server, or set `"enabled": false` on a server.

### Pi packages

At interactive-mode start, Pi checks the [Pi packages](packages.md) listed in your settings for updates: npm packages through `npm view` against your configured registry, or the command set by `npmCommand`, and git packages against their remote. In any mode, Pi installs a configured package at startup when it is missing or when the installed npm version does not match the configured version. Packages loaded with `-e` are updated on every start, unless they are pinned. npm and git use their own configuration and credentials, and installing a package can fetch its dependencies from other sources.

### fd and rg downloads

The `find` tool and path completion use `fd`, and the `grep` tool uses `rg`. When neither your `PATH` nor `~/.pi/agent/bin` contains one of them (`fdfind` also counts for `fd`), Pi downloads a release from GitHub into `~/.pi/agent/bin`. Downloads are available for macOS, Linux, and Windows on x64 and arm64. To avoid the download, install both tools with your system package manager.

## Requests to AI providers

Pi sends model requests to the AI provider's endpoint, or to the base URL you configured in [`models.json`](models.md#configure-a-compatible-endpoint), through your configured HTTP proxy if there is one. A model request contains the model context: the system prompt, the conversation history, including file contents and command output that tools read, and the tool definitions. The AI provider's data retention and privacy policies apply to that data.

Pi also sends model requests without a new prompt from you:

- **Cache warming:** with the default `cacheWarming: "idle"`, Pi repeats eligible requests during runs and for up to 30 minutes after a run to keep the provider's prompt cache warm. Set `cacheWarming` to `"off"` to stop it. See [Settings](settings.md).
- **Compaction:** when the conversation history approaches the context window, Pi sends it to the model to write a summary. See [Compaction](compaction.md).

Pi adds the following to model requests:

| Data | Sent to | Purpose |
|---|---|---|
| `User-Agent` in the format above | Most AI providers. Anthropic subscription sign-in sends `claude-cli/<version>` and `x-app: cli` instead; Amazon Bedrock adds `pi/<version>` to the AWS SDK's `User-Agent`. | Identifies Pi as the client. A `User-Agent` header in `models.json` overrides it. |
| `HTTP-Referer: https://pi.dev`, `X-OpenRouter-Title: pi`, `X-OpenRouter-Categories: cli-agent` | OpenRouter | App attribution in OpenRouter's rankings |
| `X-BILLING-INVOKE-ORIGIN: Pi` | NVIDIA NIM | App attribution |
| `x-opencode-client: pi` | OpenCode | App attribution |
| `originator: pi` | OpenAI Codex | Required by the Codex API |
| Session ID | AI providers whose API implementation supports a prompt-cache key, session header, or session field, for example OpenAI's `prompt_cache_key` and Radius | Lets the provider reuse its prompt cache and route the requests of a session together |

Attribution headers name Pi, not you. Pi adds them only while install telemetry is on; `originator: pi` is always sent. By default, the session ID is a UUIDv7 that Pi creates for each session. It encodes the creation time, not your account or machine. `--session-id` sets your own value, which is then sent instead.

## Identifiers

Pi creates no user or installation identifier by default. It stores these identifiers only in the listed cases:

| Identifier | Created | Stored in | Sent to |
|---|---|---|---|
| Session ID | For each session | The session file, unless the session is ephemeral | AI providers, as described above; `/bug` and `/share` uploads |
| `deviceId` | When you first use **Sign in with ChatGPT** for the `openai` provider | `~/.pi/agent/settings.json` | OpenAI, as the agent host ID during sign-in |
| `trackingId` | When you opt in to analytics | `~/.pi/agent/settings.json` | Not sent |

Signing in to a service can also store identifiers that the service issues, such as OAuth client registrations or the ChatGPT account ID, in `auth.json` or `mcp-auth.json`. Pi sends them only to the service that issued them.

Bug reports leave out `deviceId` and `trackingId`. Extensions can read the identifiers: `deviceId` and `trackingId` through `pi.getSettings()` or the settings file, and the session ID through `ctx.sessionManager`. The `bash` and `powershell` tools pass the session ID to the commands they run as `PI_SESSION_ID`.

## Analytics

The `enableAnalytics` setting is `false` by default. With `PI_EXPERIMENTAL=1`, the first interactive start of the official distribution, with the default agent directory and before `settings.json` exists, asks whether you want to share usage data. Opting in sets `enableAnalytics` to `true` and stores a random `trackingId`.

Pi contains no code that sends analytics. It stores the setting and `trackingId` but does not use them.

## Data you send on request

These commands send data only when you run them:

| Command | Destination | Data |
|---|---|---|
| `/bug` | `/v1/bug-reports` on the Radius gateway, by default `https://radius.pi.dev` (override: `PI_RADIUS_GATEWAY`), read by the Pi developers at Earendil. When you are signed in to Radius, the upload carries your Radius credential and is linked to your account; otherwise it is anonymous. | A report ID, your description, the session ID, Pi version, operating system, shell and terminal details, model and AI provider configuration without credentials, thinking level, global and project settings, extension paths and load errors, the names but not the values of `PI_*` environment variables, error details from failed model requests, and the last five crash records from `~/.pi/agent/crashes.json`, which include stack traces, working directories, and session file paths. The transcript of the active branch, with the working directory, or a model-written summary only if you choose it. |
| `/share` with Radius | `/v1/artifacts` on the Radius gateway, visible to your organization. Used when you are signed in to Radius. | The active branch, the working directory, the system prompt, and the tool definitions |
| `/share` with a gist | A secret GitHub gist created with `gh`. Used when you are not signed in to Radius. | An HTML export of the whole session, including all branches, the system prompt, and the tool definitions |
| `/login`, `pi auth login` | The AI provider's sign-in service | Sign-in requests, such as an OAuth flow |
| `pi install`, `pi update` | npm registry, git remotes; `pi.dev` when Pi updates itself | Package names and versions |

The [`sessionShareDestination`](settings.md#sessions-and-context) setting can force either `/share` destination. A secret gist is unlisted, but anyone with its URL can read it.

`/bug` removes settings fields whose names look like credentials, plus `deviceId` and `trackingId`. Secrets in error messages, crash records, the transcript, or under other names stay in the report. To inspect a report first, choose **Export as Zip**, which writes the same report to a local file. A model-written summary sends recent messages and your description to the current AI provider, even when you export as zip.

## Turn off network activity

| Control | Effect |
|---|---|
| `--offline` or `PI_OFFLINE=1` | Turns off the requests to `pi.dev`, provider model lists, package checks, tool downloads, and `/bug` uploads. Pi uses cached model catalogs and installed packages. |
| `PI_TELEMETRY=0` or `"enableInstallTelemetry": false` | Turns off the install and update ping and the attribution headers |
| `PI_SKIP_VERSION_CHECK=1` | Turns off the version check |
| `--no-mcp` | Connects to no MCP server |
| `"cacheWarming": "off"` | Turns off cache warming requests |

Set `PI_OFFLINE` to `1` and unset it to go back online. Pi reads other values, such as `0`, inconsistently.

Pi does not read `DO_NOT_TRACK`. Use the controls above instead.

Offline mode does not block model requests, MCP connections, commands you run explicitly (`/share`, `/login`, `pi install`, `pi update --models`), credential commands configured with `!command`, or commands that tools run. To stop all network access, run Pi in an [isolated environment](containerization.md) with restricted networking.

## What Pi's controls do not cover

[Extensions](extensions.md) and [Pi packages](packages.md) run inside the Pi process with your permissions. They receive conversation events and can make any network request; Pi's telemetry settings and offline mode do not restrict them. MCP tools receive whatever arguments the model passes them, and commands the model runs with the `bash` tool can send data anywhere. Pi gives extensions no analytics consent signal; `enableAnalytics` is not one. Review extensions and packages before you install them. See [Run Pi safely](security.md).

## Telemetry hooks for embedding applications

`@earendil-works/pi-ai` can report spans and metrics for model requests to a telemetry adapter that an embedding application provides. Without an adapter it does nothing, and the `pi` CLI provides none. See [Telemetry](../../ai/README.md#telemetry) in the `pi-ai` README.
