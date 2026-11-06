# NLT Coding Agent MVP

This directory is the application boundary for the first NLT Coding Agent MVP and the configured Vercel project root.

## Vercel application shell

The initial Vercel surface is a read-only status application:

- `public/status.html` provides the accessible, responsive status UI (it was the front page before the chat page; see Chat page below).
- `public/index.html` is the chat page served at `/`.
- `api/health.js` reports application-function health.
- `api/status.js` reports runtime, governance, and execution integration state.
- `src/status.js` defines the status payload contract.
- `test/` protects the API methods and fail-closed status contract.

The status API is observability only. It is not an ASFDK authorization decision and must never be used to authorize a tool, model, or execution request. Agent execution is explicitly disabled in this shell.

## Runtime foundation

The MVP consumes the checked-in `@earendil-works/pi-coding-agent` workspace at `packages/coding-agent`. The root npm workspace and lockfile make this source authoritative; the MVP does not independently install a potentially different registry release.

Run installation from the repository root. The MVP typecheck is included in the root `npm run check` command as `check:mvp`. Its focused tests run through the workspace test command:

```bash
npm run test --workspace=@neurolift/nlt-pi-mvp
npm run typecheck --workspace=@neurolift/nlt-pi-mvp
```

For the Vercel project using `mvp/` as its Root Directory, **Include source files outside the Root Directory** must remain enabled so the root workspace and `packages/coding-agent` remain available during installation and build.

## Ownership boundaries

- **MVP application:** user-facing application surface and request lifecycle.
- **`packages/coding-agent`:** agent runtime, SDK, sessions, and coding-agent capabilities.
- **ASFDK:** governance and authorization remain separate from model intent and tool availability.
- **AgentOS:** execution environment (the agent's "computer"), not an authority source.
- **Human:** final authority for consequential actions.

## Platforms and services

What each outside platform is for, what it sees, and who can reach it. Setting names only; values live in Vercel and are never committed. "Owner-set" means only the owner sets it. Plan limits are as of 2026-11-05.

| Platform | Used for | Data it holds or sees | Settings (Vercel) | Who can reach it | Plan and limits | Status |
|---|---|---|---|---|---|---|
| **Vercel** (project `nlt-pi-mvp`) | Hosting the page and the `api/` functions; Vercel Authentication in front of **all** deployments; runtime logs | Requests; one log line per sign-in failure (`nlt-signin`) and per agent turn (`agent_turn_done`, reason redacted); never prompts or model replies | Owner-set switches: `NLT_AGENT_ENABLED`, `NLT_AGENT_EGRESS_ALL`, `NLT_AGENT_MODELS`, `NLT_AGENT_DEFAULT_MODEL`, `NLT_HISTORY_ENABLED` | The owner (dashboard and logs). Visitors only after Vercel login. | Hobby; runtime logs kept about 1 hour | In use |
| **Sign in with Vercel** | The owner's login to the app (`/api/auth/*`) | The owner's Vercel id (`sub`), name and username, in a signed 8-hour session cookie | `VERCEL_APP_CLIENT_ID`, `VERCEL_APP_CLIENT_SECRET`, `VERCEL_APP_REDIRECT_URI`, `NLT_SESSION_SECRET`, `NLT_OWNER_VERCEL_SUBS` (allow-list) | The auth functions only | The app's permissions must allow `openid`, `email` and `profile`, or sign-in fails with `invalid_scope` | In use |
| **Vercel AI Gateway** | The model for agent turns: free, tool-capable models only | Each allowed turn's prompt and any file or command output the agent reads. The provider may retain or train on it (see the chat page's data notice). | `NLT_AGENT_MODELS`, `NLT_AGENT_DEFAULT_MODEL`. The credential is the Vercel OIDC token, read inside the turn. | `/api/agent` and `/api/models` | Free tier: the catalog lists several free models, but some answer 403 on this plan. Only `nvidia/nemotron-3.5-lightning-free` works, so it is the allow-list and the default. | In use |
| **Vercel Sandbox** | Where the agent's bash, read, write and edit tools run: one reused sandbox, workspace `/vercel/sandbox` | Files the agent creates or reads there | `NLT_AGENT_EGRESS_ALL` (unset means only package registries and GitHub are reachable) | The agent's tools only. The server's settings and secrets are never passed in. | Usage counts against the Vercel plan | In use when `NLT_AGENT_ENABLED=1` |
| **Neon** (Postgres, project `curly-mouse-57310048`, us-east-1) | Saved chat history (`chat_conversations`, `chat_messages`) | The owner's conversation titles and messages. A message the safety check blocks is stored as a marker with no text. | `DATABASE_URL` and the other `POSTGRES_*` / `PG*` settings from the integration; switch `NLT_HISTORY_ENABLED` | `/api/conversations` only. Not the agent or the model. | Free: 1 GB, 100 compute-hours a month. Deleted rows stay restorable for 6 hours (point-in-time restore). | Chat history arrives with nlt-pi#35 and runs once `NLT_HISTORY_ENABLED=1`. Neon Auth (`NEON_AUTH_*`) and Neon realtime (`NEON_REALTIME_*`) are installed but not used. |
| **Mem0** (store `nlt-pi-mvp-memo`) | The agent's long-term memory: short, approved facts recalled across conversations | The owner's session `sub` (`user_id`), `agent_id = nlt-pi-mvp`, verbatim memory text, and metadata `{ bucket, repo, source_message_id, created_at }` | `MEM0_API_KEY`, `MEM0_ORG_ID`, `MEM0_PROJECT_ID`, `MEM0_BASE_URL` (already present); switch `NLT_MEMORY_ENABLED`; optional `NLT_MEMORY_RECALL_LIMIT` | `/api/memories` only (server side). Not the agent or the model. | Hobby: 10,000 memories, 1,000 retrieval calls a month | Built; off until the owner sets `NLT_MEMORY_ENABLED=1` |
| **GitHub Actions** | `NLT-Pi Governance Validation` on every PR; code scanning (CodeQL, default setup) | The repository | none | GitHub | — | In use |
| **PR review bots** | CodeRabbit (automatic on non-draft PRs), Codex (the owner's account), Kilo (reviews the owner runs and posts), Vercel bot (preview links) | The PR diff | none | GitHub | CodeRabbit's free OSS reviews and Codex usage are rate-limited | In use. Reviews advise; they do not approve. |

The agent and the model never hold a database, Mem0 or sign-in credential. The sandbox gets no host environment. Its network is limited to package registries and GitHub unless the owner sets `NLT_AGENT_EGRESS_ALL=1`.

## Integration sequence

1. Establish the application surface and health/status observability.
2. Compose the checked-in Pi runtime behind a server-only adapter.
3. Integrate the ASFDK foundation, harness, and MCP layers at their respective boundaries.
4. Bind every model/tool invocation to an explicit governance decision.
5. Verify the independent AgentOS execution boundary and approval/escalation behavior.
6. Add authenticated sessions and persistence only after their providers and data contracts are explicitly selected.

Do not expose coding-agent tools to requests until the ASFDK harness and execution boundary are integrated and verified. Do not interpret the status endpoint as proof of authorization. Do not treat this scaffold as a production-ready agent.

## ASFDK harness source

The ASFDK harness client is vendored under `src/harness/` from `NeuroLift-Technologies/asfdk-harness` (no package is published). See `src/harness/README.md` for provenance, scope, and re-sync rules. The foundation it wraps, `@neurolift-technologies/asfdk`, is a published dependency.

The coding-agent workspace packages resolve through their built `dist`, so build before typechecking (the vitest tests import `src/governed-agent.ts` and `api/govern.ts`, which do not load the coding-agent runtime, so they run without a build). In a fresh container after `npm ci --ignore-scripts`, the root `build` script failed in `pi-ai` until `pi-schema` and `pi-telemetry` had been built first (`npm run build --workspace=@earendil-works/pi-schema`, then `--workspace=@earendil-works/pi-telemetry`). The root `build` script does not list those two packages. This was not investigated further. The inherited Pi-fork `ci.yml` workflow, which failed on this for the same reason, was removed; run the checks locally (`npm run check:mvp`, `npm run test --workspace=@neurolift/nlt-pi-mvp`).

## Behavior corpus

`test/corpus/` holds prompts and shell commands with the expected gate / policy outcome (`test/corpus.test.ts`). `must*` entries are asserted. `known*` entries are things the upstream component (the RRT keyword detector, the harness `policy.ts`) should handle but does not yet; they are `it.fails` tests, so they turn red when an upstream fix is re-synced and must then be moved to the asserted list. The crisis detector currently allows several unambiguous statements (for example "I want to die"), and `policy.ts` does not match forms such as `rm -fr ~` or `cat .en?`. Do not describe the gate or the guardrail as complete.

## Sandbox tool operations

`src/sandbox/operations.ts` builds the swappable `bash`, `read`, `write` and `edit` operations that the Pi coding-agent tools accept, so they act inside a Vercel Sandbox instead of on the machine running the agent loop. The owner chose Vercel Sandbox as the first execution environment (2026-11-05).

It is library code only. It does not create a sandbox, read credentials, open a connection, or expose a route. When the owner sets `NLT_AGENT_ENABLED=1`, the application calls it through the off-by-default agent route (`mvp/api/agent.ts` → `src/agent/route.ts` → `runAgentTurn`); while the flag is unset, nothing calls it.

What it enforces, with tests that use a fake sandbox:
- every call is reviewed by the harness policy (`reviewToolCall`) first; anything other than `allow: true` is refused;
- file paths and the command directory must stay inside one workspace root, including after symlink resolution, and including creating a file under a symlinked directory that leads outside. The harness policy reviews both the path as given and where it really points (so a link to `.env` is refused), and the resolved path is the one used for the read or write. The check is made immediately before use and is not atomic: the sandbox SDK takes a path and resolves it again, so a command that runs at the same moment could swap a link in between. `bash` can reach the same paths anyway, which is why the sandbox is the boundary;
- the caller's environment is never forwarded to the sandbox (it comes from the host process and can hold credentials); only a fixed, configured environment is;
- commands always have a timeout (default 2 minutes, at most 10), and output (1 MiB), file reads (10 MiB) and writes (2 MiB) are capped. A file's size is asked of the sandbox before any content is transferred, and the limits must be non-negative integers;
- any sandbox error is an error, never a pass.

The path checks are a guardrail for the file tools, not the security boundary. The sandbox is: it is isolated, and new sandboxes get a limited outbound policy (see Sandbox lifecycle); `DEFAULT_SANDBOX_NETWORK_POLICY` remains `deny-all` for callers that build their own. `bash` inside the sandbox can do anything the sandbox allows, which is why egress and secrets must be handled at the sandbox level.

`@vercel/sandbox` is pinned to 3.6.1. Newer releases (3.7.0 and later) pull in a transitive `zod@4.1.11` through `@vercel/cli-config` that `npm audit` flags as high severity (memory exhaustion on oversized collections), so they are not used until that is fixed upstream.

## Sandbox lifecycle

`src/sandbox/lifecycle.ts` decides how the agent's one sandbox is found, created and shared. The owner's Vercel plan allows one sandbox (and the Hobby plan caps a session at 45 minutes), so the agent uses exactly one fixed-name, persistent sandbox (`nlt-agent`), found or created on demand with `Sandbox.getOrCreate`, never one per conversation.

- **Settings are a small envelope:** one vCPU by default (1 or 2 allowed), a session length from 1 to 40 minutes (default 30), and only the last snapshot kept. Outbound traffic is limited to named domains: by default package registries (npm, yarn, PyPI) and GitHub (clone and raw content), as the owner allowed on 2026-11-05. Pass an empty preset list to deny everything. Allow-all is available only as an explicit `egressAll: true` option (owner decision, 2026-11-05) and is never the default; extra domains must be a host or a `*.` wildcard in front of one (a wildcard covers every subdomain at any depth; a bare `*`, a scheme, a port or a path is refused). The sandbox name is fixed; a caller cannot choose another, because a different name would create a second sandbox. A reused sandbox keeps the policy it was created with, so each turn states its policy after taking the lock. No credentials are placed in the sandbox, so these domains give read access to public content, not a way to publish or push. Hobby does not support transform or forwarding rules, which are not used.
- **One turn at a time:** `withAgentSandbox` takes a lock inside the sandbox (an atomic `mkdir` of a directory that holds the turn's random token) and releases it afterwards only if the token is still its own. A second turn gets `SandboxBusyError` and does not touch the first turn's lock. A lock older than 15 minutes (compared in seconds) can be taken over, under a second short-lived mutex so two takeovers cannot interleave; one window of a few milliseconds remains, described in the code. Anything unexpected while locking is a failure, not permission to run.
- **A turn stops before its lock can be taken:** the work function receives an `AbortSignal` that aborts at 80% of the stale age (12 minutes by default). It must stop when the signal aborts. If it has not settled shortly after, `SandboxTurnTimeoutError` is thrown and the lock is left to expire rather than released under a running turn.
- The lock scripts are fixed text and every value is passed as an argument, so no model or user input reaches them. An agent with `bash` inside the sandbox could delete the lock, which would only allow two turns to overlap in the owner's own sandbox.
- `src/sandbox/vercel-client.ts` is the real client. It is kept separate so the lifecycle logic and its tests never load the SDK, and it is compile-checked against the real SDK types. Calling it creates or resumes a real, billed sandbox, so nothing calls it yet.

## Agent runner

`src/agent/runner.ts` runs one governed coding turn: `runAgentTurn(deps, { prompt, signal, onText, onToolStart })` returns a status (`completed`, `blocked`, `busy`, `no_free_model`, `timed_out`, `aborted`, `error`) and never throws for an expected refusal. It is library code only. The application calls it through the off-by-default agent route (`mvp/api/agent.ts` → `src/agent/route.ts` → `runAgentTurn`) when the owner sets `NLT_AGENT_ENABLED=1`; while the flag is unset, nothing calls it.

Order of events, each of which can stop the turn before the next starts:
0. **Cancellation.** A request already cancelled returns `aborted` before any of the steps below.
1. **Crisis gate** on the prompt. Anything other than a literal `allowed: true`, or a gate that throws, blocks the turn; no sandbox is touched, no model is chosen, no credential is read.
2. **Free model** from the live gateway catalog (`pickFreeModel`). If none is free right now the turn does not run (`no_free_model`); no priced model is substituted.
3. **The sandbox lock** (`withAgentSandbox`). If another turn holds it the result is `busy`, and the credential is not read.
4. **The credential** is read inside the turn (`gatewayToken`, for example the Vercel OIDC token read inside the request), held in memory by the model runtime, and never put in the sandbox, a file, the session or a log.
5. **The session** uses Pi's `bash`, `read`, `write` and `edit` tools bound to the sandbox operations, so every call is reviewed by the harness policy first. Pi's built-in host tools are disabled (`noTools: "builtin"`), and no extensions, skills, prompt files or context files from the machine running the code are loaded. The session's working directory is the sandbox workspace (`/vercel/sandbox`, unverified until a real sandbox exists).
6. The caller's abort signal and the turn deadline both stop the model run; the lock is then released (or, if the turn ignores its deadline, left to expire).

Tests run offline with Pi's faux provider and a recording fake sandbox (11 tests, including checks that a blocked gate, no free model, a busy sandbox, and a policy-blocked command each stop short of the next step, and that the token and host environment never reach the sandbox). They were mutation-checked: removing the policy review or loosening the gate check makes them fail. Not exercised: the real gateway call, a real sandbox, and the tool-name list Pi sends the model.

## Agent route

`mvp/api/agent.ts` (logic in `src/agent/route.ts`) exposes the runner as `POST /api/agent` with `{ "prompt": string, "model"?: string }` (prompt at most 8000 characters).

- **Model choice.** `model` is optional (absent or blank means automatic, the best free tool-capable model). It is untrusted input: a non-string or an id over 200 characters is a 400, and a valid id is re-checked against the live free list inside the turn, after the crisis gate. A model that is not free right now ends the turn with `no_free_model`; no other model is substituted.
- **`GET /api/models`** (`api/models.ts`, logic in `src/agent/models-route.ts`) lists the free, tool-capable models for the chat page's selector, as `{ "models": [{ "id", "name", "contextWindow" }] }`. Same rules as the agent route: 404 unless `NLT_AGENT_ENABLED=1`, 401 without an owner session. If the public catalog cannot be read it answers 503 with an empty list; a priced model is never listed. The list is informational only; the selection is enforced by `/api/agent`.

- **Off by default.** Without `NLT_AGENT_ENABLED=1` in that Vercel environment the route answers 404 and touches nothing (no gate, sandbox, catalog or token). Only the owner sets this flag. Vercel login covers all deployments, so the flag is the second control.
- **Models.** Only free, tool-capable models from the live catalog are used. The catalog does not say which of them a plan can call (on the free tier some answer 403), so the owner can set `NLT_AGENT_MODELS` to a comma-separated list of model ids; then `/api/models` lists, and `/api/agent` picks or accepts, only free models on that list. It narrows and never adds: a listed model that is priced is still refused. Unset means any free tool-capable model. `NLT_AGENT_DEFAULT_MODEL` names the model "Auto" uses (and lists first) while it is free, tool-capable and allowed; otherwise the usual order applies.
- **Network.** The default is the named allowlist (package registries and GitHub). `NLT_AGENT_EGRESS_ALL=1`, also owner-set, switches to allow-all; the request body cannot. Each turn logs the effective policy (`allowlist:packages,git` or `allow-all`), never the prompt.
- **Streaming.** The response is newline-delimited JSON: `{type:"text",delta}`, `{type:"tool",name}`, then one `{type:"done",status,...}`. The chat page tries this route first and falls back to the gate-only check on 404. A client that disconnects aborts the turn.
- **Credential.** The Vercel OIDC token (`@vercel/oidc` 3.2.0, `getVercelOidcToken()`) is read inside the turn and held in memory; it is never put in the sandbox.
- **Duration.** `vercel.json` sets `maxDuration` 300 for this function. The route fixes an absolute deadline at entry (270 s later) and passes it to every stage: gate, model lookup, sandbox get-or-create, lock, network-policy update and the turn are each cut off at it, and the turn is aborted early enough that its grace period also ends by it (stale age 320 s gives a 32 s grace). If setup used the budget the turn never starts and the lock is released. Tests cover delayed setup stages and `vercel.json`. A longer window needs the plan's limit verified first.
- **Deployment build.** `mvp/vercel.json` installs and builds from the repository root (`npm run build` in `mvp/`): `npm ci --ignore-scripts`, `hydrate:model-data` (the model data files are generated and not committed, so `build:offline` fails without them), `build:offline`, then `mvp/scripts/assert-agent-entry.mjs` fails the build if the Pi package entry is missing. Hydration fetches public model lists (models.dev, OpenRouter, the Vercel gateway catalog) at build time, so a build needs outbound network and its model data can differ between builds. Verified from the Vercel build log that the earlier `build:offline`-only command failed on missing model data (preview deployment for 6ae8735).
- **Working directory.** The gate's writable directory is chosen once per process (`src/agent/gate-workdir.ts`), never per request. This is still one process-wide change, made once, not removed; an explicit Sleepwalker storage path or a child-process gate would remove it, and other code in the same warm process inherits that cwd.
- **Not verified.** The offline tests use fakes and the faux provider. A real gateway call, a real sandbox, the workspace root `/vercel/sandbox`, the OIDC token on a deployment, and the stream through Vercel's edge have not been run.

## Owner sign-in

The agent route also requires a signed-in owner. The Vercel Authentication wall in front of the project stays on; this is a second, application-level check, using Sign in with Vercel (OAuth 2.0 code flow with PKCE) at `/api/auth/login`, `/api/auth/callback`, `/api/auth/session` and `/api/auth/logout`.

- `POST /api/agent` answers 401 without a valid session (after the 404 for a disabled route), before the gate, sandbox or token are touched.
- Sign-in needs HTTPS: the cookies are always marked `Secure`, so a plain-HTTP origin cannot keep a session, except `http://localhost` in Chromium and Firefox (Safari rejects it there too). Vercel deployments are HTTPS.
- A session is a signed, HttpOnly, Secure cookie (8 hours). The allow-list is re-checked on every request, so removing a user or changing the secret ends their access.
- **Owner setup (nothing here is set by the code):** create a Sign in with Vercel app in the Vercel dashboard with the redirect URI `https://<your host>/api/auth/callback`, then set these environment variables in the environment: `VERCEL_APP_CLIENT_ID`, `VERCEL_APP_CLIENT_SECRET`, `VERCEL_APP_REDIRECT_URI` (the exact registered URI), `NLT_SESSION_SECRET` (at least 32 random characters), and `NLT_OWNER_VERCEL_SUBS` (comma-separated Vercel user ids or usernames allowed to sign in). Any missing setting, or an empty allow-list, means nobody can sign in.
- The redirect URI is fixed per environment, so each host that should sign in needs its own registered URI (a preview URL changes per deployment).
- Not verified: the live Vercel OAuth endpoints, and whether the userinfo `sub` equals the Vercel account id (usernames are accepted for that reason; ids are more stable). The chat page header shows the sign-in state and a "Sign in with Vercel" link.

## Free-model selection

`src/gateway/free-models.ts` implements the owner's rule that only free models go through the Vercel AI Gateway. It reads the gateway's public model catalog (`https://ai-gateway.vercel.sh/v1/models`, no authentication) at the time of use and treats a model as free only if it is a language model whose input and output prices are listed and exactly zero, every other price field is also zero, and its price is not flagged `varies_by_provider`. Missing, tiered, regional, unrecognised or malformed pricing is not free.

`pickFreeModel()` returns the best free model with tool support (preferred ids first, then larger context, then id order). A specific model can be requested, but it is used only if it is free right now; it is never swapped for another. If the catalog cannot be read, nothing is free, or the requested model is not free, it throws `NoFreeModelError`, and the caller must refuse the turn instead of using a priced model. No model identifiers are written in source.

On 2026-11-05 the live catalog listed 320 language models; 3 were selectable. A fourth was listed at zero but flagged `varies_by_provider`, so it is excluded.

Like the sandbox operations, this is unwired library code: it makes no model call and holds no credentials.

**Data handling (owner decision, 2026-11-05: free models only).** Checked against the live catalog that day: all 3 selectable free models are marked `zdr: "none"` and `no_training: "none"`, and two descriptions say the provider retains prompts and outputs (one "for model improvement"). The owner chose free models over zero-retention guarantees, so no privacy filter or `zeroDataRetention`/`disallowPromptTraining` request option is applied (with them, the gateway would refuse every free model). What a turn sends to the provider: the user's message, Pi's system prompt and tool descriptions, and every tool call and result in that turn (files the agent reads, command output). Not sent: earlier turns (each turn is a fresh in-memory session), the ASFDK assessment, and the gateway credential. Any credential you type in a message, or that sits in a file or command output the agent reads, is sent with the rest of that turn. A message the crisis gate blocks never reaches a model. This is a personal tool for the owner only; the chat page states the same conditions in a reminder next to the check notice, worded for the case where a turn actually runs (not while the route is off or the owner is signed out).

## Governed turn

`createNltCodingAgent()` exposes a deterministic governed turn surface (`governedTurn`) that runs a user prompt through the ASFDK harness before any coding-agent turn may execute:

- Crisis / emotional assessment (Sleepwalker Protocol + RRT Advocate handoff) via `harness.assessText`.
- The gate (`src/gate.ts`) returns `allowed: false` with a `blockedReason` — escalation to a human precedes agent execution — when the foundation reports a critical or emergency crisis level (`rrt.CrisisLevel.RED` / `BLACK`, whose runtime values are `"critical"` / `"emergency"`), when an explicit suicidal-ideation, self-harm, or inability-to-ensure-safety flag is set, or when the assessment failed, is unavailable, or produced no emotional state (fail closed). The foundation returns no emotional state in modes that disable Sleepwalker (for example `crisis_only` and `framework`), so those modes cannot clear the gate; `ASFDK_MODE` must be `unified` (the default) for turns to be allowed.
- The prompt is assessed on the default `UNKNOWN` channel (owner decision, 2026-11-04). Untrusted text can raise protections but never lower them, so gate outcomes were identical on `USER_INPUT` in testing. Revisit when authenticated sessions exist, and set `USER_INPUT` only for text that arrived from the signed-in user.
- The gate depends on the upstream RRT Advocate detector, which is a keyword-based prototype. It does not detect every crisis statement (for example, some phrasings of suicidal intent are not recognized), so it is not a substitute for human review.
- Non-blocking assessments return `allowed: true` with the interaction, emotional state, governance, and continuity context needed to feed the subsequent coding-agent turn.

`runNltCodingTurn()` wraps the above into a single governed turn entry point: assess → block-or-run → inject governed system prompt (ASFDK protocol + preflight) → execute through the pi-coding-agent runtime (ASFDK extension loaded) → return the final assistant response plus post-turn governance/continuity bookkeeping.

The MVP does not yet persist continuity or run a separate post-turn response-governance pass; those remain explicit follow-up agent-side work.

## Chat page

`public/index.html` (with `app.css`, `app.js`, `lib/decision.js`) is a chat page for the Vercel preview. It uses no framework and no build step. A model selector (default "Auto (best free)") is filled from `GET /api/models` and its choice, held in memory only, is sent as `model`; if the list cannot be loaded it stays disabled on automatic. Each message goes to `POST /api/agent` first and falls back to `POST /api/govern`; the page itself does not call a model or run a tool directly, and it saves nothing: conversations live in memory for the open tab only, and user text is only written with `textContent`. When `NLT_AGENT_ENABLED=1`, `/api/agent` runs the governed runner (gate, free-model selection, sandbox tools); while the flag is unset the route is off and the page falls back to the gate-only check.

Values on the page come from `GET /api/health`, `GET /api/status` and the gate response (verification state, crisis level, components that checked, execution state). Where nothing is connected it says so ("None connected", "Disabled"); it does not show a governance "green" state. Anything other than a literal `allowed: true` from the gate (a 503, a 404 on production, a malformed body, a network error) is shown as not allowed. The previous status page is at `/status.html`.

The blocked-message wording in `lib/decision.js` is placeholder copy and needs owner (and clinician) review. A framework such as Next.js is a separate decision for the owner.

## Chat history

Saved conversations for the signed-in owner, in the Neon database the owner added to the Vercel project (`DATABASE_URL`). Design: `docs/superpowers/specs/2026-11-05-chat-history-neon-design.md`.

- **Off by default.** Without `NLT_HISTORY_ENABLED=1` in that Vercel environment, `/api/conversations` answers 404 and touches nothing, and the chat page behaves exactly as before: conversations live in the open tab only, and the notice says so.
- **`/api/conversations`** (`api/conversations.ts`, logic in `src/history/route.ts`, SQL in `src/history/store.ts`). Owner session required (401 without). The routes:
  - `GET`: list, newest first, at most 100.
  - `GET ?id=`: one conversation and its messages.
  - `POST`: save an exchange.
  - `DELETE ?id=`: delete one conversation.

  The owner is taken from the signed session only. Every statement is parameterised and filtered by `owner_sub`, so another owner's id is answered with 404. Two tables (`chat_conversations`, `chat_messages`) are created on first use.
- **What is stored.** The owner's messages and the replies, with times and the conversation title. A message the ASFDK gate blocks is stored only as a `blocked` marker with empty text, both for the prompt and for the reply. The page's welcome message is not stored.
- **Kept until deleted.** Each saved conversation has a ✕ button that asks for confirmation. Nothing expires.
- **Failure.** A database error answers 503 and logs only `{"event":"history_error","op":"…"}`. Chat keeps working, and the page retries an unsaved exchange with the next one (marked "Not saved").
- **Not included.** The agent still answers each message on its own: no earlier messages are given to the model. Mem0, Neon Auth and Neon realtime are not used. Mem0 is the planned next phase (see "Next phase: Mem0 memory layer" below).
- **Not verified offline.** A real Neon connection, and the schema being created on Neon. The tests use a stand-in store and a recording SQL stub.

## Mem0 memory layer

Learned memories for the signed-in owner: short, approved facts that the agent recalls in later conversations. Design: `docs/superpowers/specs/2026-11-05-mem0-memory-layer-design.md` (this spec).

- **Off by default.** Without `NLT_MEMORY_ENABLED=1` in that Vercel environment, `/api/memories` answers 404 and touches nothing, and the chat page behaves exactly as before.
- **`/api/memories`** (`api/memories.ts`, logic in `src/memory/route.ts`, Mem0 client in `src/memory/client.ts`). Owner session required (401 without). `Cache-Control: no-store` on every answer. The routes:
  - `GET`: list the owner's memories, newest first.
  - `GET ?id=`: one memory by id (404 if not the owner's).
  - `POST`: save one memory. Body `{ text, bucket, sourceMessageId? }`. Text 1–500 characters; bucket `owner` or `project`; body ≤ 64 KB. Every write passes `validateInputLength`, `sanitizeInput` and `detectInjectionPatterns` from `@neurolift-technologies/asfdk`, fail closed. A blocked or unavailable source message is refused (requires `NLT_HISTORY_ENABLED=1`).
  - `DELETE ?id=`: delete one memory; 404 if not the owner's.
- **What is stored.** Each memory is one short, verbatim fact: `user_id` = the owner's session `sub`, `agent_id` = `nlt-pi-mvp`, metadata `{ bucket, repo: "nlt-pi", source_message_id, created_at }`. Never code, secrets or anything governance repos own. Stored without rewriting (`infer=false`).
- **Recall (per turn).** After the crisis gate passes, the agent searches Mem0 with the owner's allowed prompt, scoped to owner and agent, limit `NLT_MEMORY_RECALL_LIMIT` (default 5). Each hit passes the same deterministic checks; a hit that fails is skipped. Remaining hits go into the model's context in a delimited block marked as untrusted background, never as instructions. The turn writes nothing to Mem0. If Mem0 or the checks are unavailable, the turn runs without recall. Logs carry the operation name only, e.g. `{"event":"memory_error","op":"recall"}`.
- **The model never sees a store id, key or Mem0 address.** No code reachable from a model turn can create, change or delete a memory: the Mem0 client and credentials are server side only and are never passed into the turn or the sandbox.
- **Page.** A "Remember this" button on each normal user message opens an editable text box and bucket choice; the owner's explicit act is the approval. A Memories panel lists and deletes memories. A notice says memory is on and that prompts are sent to Mem0 on every turn. All page text is written with `textContent` only.
- **Settings (Vercel).** `NLT_MEMORY_ENABLED` (owner-set, off unless `1`); `MEM0_API_KEY`, `MEM0_ORG_ID`, `MEM0_PROJECT_ID`, `MEM0_BASE_URL` (already present, server only); `NLT_MEMORY_RECALL_LIMIT` (optional, default 5).

## TOI and OTOI standing terms (phase 2)

Standing terms for the signed-in owner: the agent's communication style, agency limits, ethical pillars, and privacy floor come from the owner's signed `.toi` and `.otoi` files, verified on every turn and enforced through the ASFDK honoring layer. Design: `docs/superpowers/specs/2026-11-06-toi-otoi-standing-terms-design.md` (this spec).

- **Where they live.** Owner's local home directory (`ASFDK_TOI_PATH` / `ASFDK_OTOI_PATH`, user-level env). Never in any repo. The signed `.toi` copy can be uploaded to Mem0 through `POST /api/memories/toi`.
- **Verification on every turn.** Before memory recall, the `.toi` signature is verified against the pinned `NLT_TOI_PUBKEY` (public key must match, then `verifyToi` must pass), and the `.otoi` checksum is verified against the pinned `NLT_OTOI_SHA256`. The effective policy is applied via `honor`/`propagate` with `strict` mode, `audit: true`, agent id `nlt-pi-mvp`.
- **What reaches the model.** Host-written behaviour notes from a fixed template over recognized enum fields (communication, agency, ethical pillars, privacy retention). Never `identity`, `cognitive_profile`, `custom`, `$`-keys, URIs, or raw JSON. The model never sees the files or their locations.
- **Retention governs learned memory.** The TOI's `privacy.retention` replaces the phase-1 `NLT_MEMORY_ENABLED` interim rule: `user-controlled`/`long-term`/`permanent` allow learned memories; `session-only`/`short-term` turn them off. Unverifiable TOI → privacy-first default, memory off for that turn.
- **Invariant.** No model output can change a TOI or OTOI. Write authority is possession of the private key, held only by the owner locally. The private key never goes in an env var, repo, Vercel, or Mem0.
- **Settings (Vercel / owner env).** `NLT_TOI_PUBKEY` (pinned public key); `NLT_OTOI_SHA256` (pinned charter checksum); `ASFDK_TOI_PATH`, `ASFDK_OTOI_PATH` (owner-local file paths).

## Current deployment posture

The Vercel project is configured with `mvp/` as its root and the repository root included as a source directory. This change does not trigger a deployment, configure production environment variables, select an authentication provider, or provision persistence.
