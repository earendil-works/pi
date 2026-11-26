# Telemetry

Pi sends an install-and-update ping to `pi.dev` after it is installed or updated. It also contacts `pi.dev` for a version check and model catalog updates, adds attribution headers to requests for some AI providers, and sends a bug report when you run `/bug`. Pi contains no analytics or crash-reporting SDK and creates no identifier for you or your installation by default.

## Requests to pi.dev

| Request | Destination | When | Data sent | Turn off with |
|---|---|---|---|---|
| [Install and update ping](#install-and-update-ping) | `https://pi.dev/api/report-install` | Interactive mode: the first run and the first run after an update | Pi version, `User-Agent` | `PI_TELEMETRY=0`, `enableInstallTelemetry: false`, offline mode |
| [Version check](#version-check) | `https://pi.dev/api/latest-version` | Every interactive-mode start | `User-Agent` | `PI_SKIP_VERSION_CHECK=1`, offline mode |
| [Model catalog update](#model-catalog-updates) | `https://pi.dev/api/models/providers/<provider>` | Interactive-mode and RPC-mode start, model selection (`/model`, `/scoped-models`), sign-in (`/login`, `pi auth login`) | AI provider ID, `User-Agent` | offline mode |

The `User-Agent` names Pi's version, operating system, runtime, and CPU architecture, for example `pi/1.6.1 (darwin; node/v24.11.0; arm64)`. As with any HTTP request, the server also sees the IP address the request comes from. None of these requests contains prompts, code, credentials, or an identifier.

Print mode and JSON mode make none of these requests. They use the model catalog cached by earlier runs.

### Install and update ping

Pi sends one `GET` request with its version as a query parameter, for example `https://pi.dev/api/report-install?version=1.6.1`. The request carries no cookie, ID, or request body.

Pi sends it in interactive mode when it records a new version: on the first run and on the first run after an update with new changelog entries. Pi records the version only when it starts with an empty conversation; while you resume or continue sessions, the ping waits. Pi gives up after 5 seconds, ignores errors, and does not retry.

Turn it off with any of these:

- Set `enableInstallTelemetry` to `false` in [settings](settings.md#updates-telemetry-and-warnings), or turn off **Install telemetry** in `/settings`. The default is `true`.
- Set `PI_TELEMETRY=0`. When set, `PI_TELEMETRY` overrides the setting: `1`, `true`, or `yes` in any letter case turns telemetry on, and any other value, including an empty one, turns it off.
- Use offline mode.

The same switch controls the [attribution headers](#metadata-in-model-requests).

### Version check

At every interactive-mode start, Pi requests the latest version from `pi.dev` and shows a notification when a newer version exists. Setting `PI_SKIP_VERSION_CHECK` to any non-empty value skips this check. `pi update` makes the same request when it updates Pi itself.

### Model catalog updates

Pi ships with a model catalog. To learn about new models and price changes between releases, Pi requests the current catalog of each built-in AI provider from `pi.dev`, for example `https://pi.dev/api/models/providers/anthropic?types=chat,image,classifier`.

Pi requests an AI provider's catalog only when that provider has authentication configured, for example through `/login`, `auth.json`, `models.json`, or an environment variable such as `ANTHROPIC_API_KEY`. The request contains the AI provider ID, never the credential, so `pi.dev` can see which built-in AI providers you have configured.

Pi reuses a cached catalog for 4 hours before requesting it again, and sends `If-None-Match` when it has a cached copy. The OpenRouter catalog is requested on every update. `pi update --models` forces a refresh. Pi saves the results in `~/.pi/agent/models-store.json` and uses them offline and in print mode.

## Metadata in model requests

Model requests go to the AI provider you choose. Besides the model context, Pi adds the following about itself:

| Data | Sent to | Purpose |
|---|---|---|
| `User-Agent` in the format above | Most AI providers. Anthropic subscription sign-in sends `claude-cli/<version>` and `x-app: cli` instead; Amazon Bedrock adds `pi/<version>` to the AWS SDK's `User-Agent`. | Identifies Pi as the client. A `User-Agent` header in `models.json` overrides it. |
| `HTTP-Referer: https://pi.dev`, `X-OpenRouter-Title: pi`, `X-OpenRouter-Categories: cli-agent` | OpenRouter | App attribution in OpenRouter's rankings |
| `X-BILLING-INVOKE-ORIGIN: Pi` | NVIDIA NIM | App attribution |
| `x-opencode-client: pi` | OpenCode | App attribution |
| `originator: pi` | OpenAI Codex | Required by the Codex API |
| Session ID | AI providers whose API implementation supports a prompt-cache key, session header, or session field, for example OpenAI's `prompt_cache_key` and Radius | Lets the provider reuse its prompt cache and route the requests of a session together |

Attribution headers name Pi, not you. Pi adds them only while install telemetry is on; `originator: pi` is always sent.

## Identifiers

| Identifier | Created | Stored in | Sent to |
|---|---|---|---|
| Session ID | For each session | The session file, unless the session is ephemeral | AI providers, as described above; [bug reports](#bug-reports) and `/share` uploads |
| `deviceId` | When you first use **Sign in with ChatGPT** for the `openai` provider | `~/.pi/agent/settings.json` | OpenAI, as the agent host ID during sign-in |
| `trackingId` | When you opt in to [analytics](#analytics) | `~/.pi/agent/settings.json` | Not sent |

By default, the session ID is a UUIDv7 that Pi creates for each session. It encodes the creation time, not your account or machine. `--session-id` sets your own value, which is then sent instead.

Extensions can read these identifiers: `deviceId` and `trackingId` through `pi.getSettings()` or the settings file, and the session ID through `ctx.sessionManager`.

## Analytics

The `enableAnalytics` setting is `false` by default. With `PI_EXPERIMENTAL=1`, the first interactive start of the official distribution, with the default agent directory and before `settings.json` exists, asks whether you want to share usage data. Opting in sets `enableAnalytics` to `true` and stores a random `trackingId`.

Pi contains no code that sends analytics. It stores the setting and `trackingId` but does not use them.

## Bug reports

`/bug` sends a report to the Pi developers at Earendil only when you run it. Before it uploads anything, it shows what the report contains and asks whether to include the transcript.

- **Destination:** `/v1/bug-reports` on the Radius gateway, by default `https://radius.pi.dev` (override: `PI_RADIUS_GATEWAY`). When you are signed in to Radius, the upload carries your Radius credential and is linked to your account; otherwise it is anonymous.
- **Always included:** a report ID, your description, the session ID, Pi version, operating system, shell and terminal details, model and AI provider configuration without credentials, thinking level, global and project settings, extension paths and load errors, the names but not the values of `PI_*` environment variables, error details from failed model requests, and the last five crash records from `~/.pi/agent/crashes.json`, which include stack traces, working directories, and session file paths.
- **Included if you choose:** the transcript of the active branch, with the working directory, or a model-written summary.

`/bug` removes settings fields whose names look like credentials, plus `deviceId` and `trackingId`. Secrets in error messages, crash records, the transcript, or under other names stay in the report. To inspect a report first, choose **Export as Zip**, which writes the same report to a local file. A model-written summary sends recent messages and your description to the current AI provider, even when you export as zip.

## Turn off telemetry

| Control | Effect |
|---|---|
| `PI_TELEMETRY=0` or `"enableInstallTelemetry": false` | Turns off the install and update ping and the attribution headers |
| `PI_SKIP_VERSION_CHECK=1` | Turns off the version check |
| `--offline` or `PI_OFFLINE=1` | Turns off all requests to `pi.dev` and `/bug` uploads, as well as other background network activity such as package update checks. Pi uses cached model catalogs. |

Set `PI_OFFLINE` to `1` and unset it to go back online. Pi reads other values, such as `0`, inconsistently.

Pi does not read `DO_NOT_TRACK`. Use the controls above instead.

## What these controls do not cover

[Extensions](extensions.md) and [Pi packages](packages.md) run inside the Pi process with your permissions. They can collect and send any data, and Pi's telemetry settings and offline mode do not restrict them. Pi gives extensions no analytics consent signal; `enableAnalytics` is not one. The same applies to [MCP servers](mcp.md) you connect and to commands the model runs with the `bash` tool. Review extensions and packages before you install them. See [Run Pi safely](security.md).

## Telemetry hooks for embedding applications

`@earendil-works/pi-ai` can report spans and metrics for model requests to a telemetry adapter that an embedding application provides. Without an adapter it does nothing, and the `pi` CLI provides none. See [Telemetry](../../ai/README.md#telemetry) in the `pi-ai` README.
