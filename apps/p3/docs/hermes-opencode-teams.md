# Hermes and opencode v2: team mode, and what p3 can take from them

Research note, 2026-11-14 (subagent "hermes-opencode"), same question as `openclaw-teams.md`. Sources, shallow clones:

- **Hermes Agent**: `github.com/NousResearch/hermes-agent` at `275bad46` (2026-11-13), in `/tmp/hermes-agent`. Docs are
  under `website/docs/`.
- **opencode v2**: `github.com/sst/opencode` (redirects to `anomalyco/opencode`; same HEAD), branch `dev` at
  `f6e0c2d0` (2026-11-13), version 2.3.0, in `/tmp/opencode`. Docs are under `services/site/src/docs/content/`
  (served on opencode.ai).

"Code" means I read the source. "Docs" means only the documentation says so. The OpenCode Console (opencode's team
product) is not in the repository, so everything about it is docs only.

## Short answer

Neither system has what p3 is after: several people with different rights on one server, extending it themselves.

- **Hermes** is a single-tenant personal agent. Other people only reach it as allowlisted chat senders, and "all
  callers are equally trusted". Every dashboard login "acts as you, the machine owner".
- **opencode v2's server** has exactly one principal: one password, fixed username `opencode`. Its team features live
  in the hosted OpenCode Console. The Console is a control plane: it pushes models, remote MCP servers and deny
  policies to each member's own local server. v2 has no session sharing; it was retired.

Both load plugins into the server process. In both, an ordinary file write by the agent can become loaded server
code:

- Hermes: the gateway `hooks/` directory loads whatever is placed there.
- opencode: `.opencode/plugins/` is auto-discovered and hot-reloaded.

Three things are worth taking:

- Hermes' per-profile **out-of-process plugin host**: a working version of p3's "personal plugins outside the server
  process".
- opencode's **allow-listed remote config**: a team admin can push data and remote endpoints, never code or local
  commands.
- opencode's **policy layers that only tighten**.

## Hermes: how it works

**Trust model (docs).** `SECURITY.md:34`: "Hermes Agent is a single-tenant personal agent". `:60`: "The only
security boundary against an adversarial LLM is the operating system". `:214`: "Within the authorized set, all
callers are equally trusted … Operators who need capability separation should run separate agent instances".
`:218`: "Profiles are not tenants". Every profile under one OS user can reach every sibling profile's files. To
separate people, run separate OS users or containers (`web-dashboard.md:78-86`).

**Identities (code and docs).** There are three unrelated kinds.

1. **Chat senders** (Telegram, Slack, Discord and so on). They are admitted by platform allowlists or by DM pairing:
   the bot replies with a code and the operator runs `hermes pairing approve`. The default is deny
   (`security.md:466-560`; code `gateway/authz_mixin.py:760` `_is_user_authorized`, `gateway/pairing.py:530`).
2. **Dashboard / remote Desktop logins.** Three ways to sign in: username/password, Nous Portal OAuth, or
   self-hosted OIDC. A non-loopback bind refuses to start without one of them. Every login is the owner:
   "Every account that can sign in acts as you, the machine owner" (`web-dashboard.md:966`). I found no role or
   scope field in `hermes_cli/dashboard_auth/*.py` (code, grep).
3. **Peer passes** (`web-dashboard.md:1196-1215`, code `hermes_cli/dashboard_auth/peer_pass.py`). These are
   short-lived tokens through which another Hermes agent calls this one. There are two scopes:
   - `agents:message`: chat in one "Bot Chat" session;
   - `agents:control`: every session, approvals, cron.

   The turn author is set to the verified holder, "whatever the request body says".

**Roles.** The only tiers are inside chat (code `gateway/slash_access.py:1-60`):

- `allow_admin_from` (and `group_allow_admin_from` for groups) lists the admins, who may run every slash command.
- `user_allowed_commands` lists the commands non-admins may run, on top of a floor of `help` and `whoami`.
- Gating is off until an admin list exists.

Answering an approval counts as running `/approve`, so a non-admin cannot answer one (`security.md:291-325`). Plain
chat is never gated. Admins are assigned by editing config. The dashboard has no roles.

**Profiles.** A profile is a separate Hermes home: config, `.env` secrets, skills, memory, sessions and bots. One
gateway serves all profiles (`gateway.multiplex_profiles`, default on). Secrets, allowlists, MCP connections and
session namespaces are resolved per profile and fail closed (`multi-profile-gateways.md:658-700`).
`gateway.profile_routes` routes chat senders, channels or guilds of one shared bot to a profile (`:750-860`). But
"sender routing selects a profile; it is not deny-by-default authorization" (`:815`). So "one profile per person" is
possible, but it stays inside one trust envelope.

**Python plugins (code and docs).**

- **Where they run.** By default plugins are imported into the agent/gateway process with full privileges
  (`SECURITY.md:157`).
- **Who enables them.** Installed plugins are discovered but not loaded until their name is in `plugins.enabled` in
  the profile's `config.yaml` (`plugins.md:173-175`; code `hermes_cli/plugins_discovery.py:322`, "not enabled in
  config"). So whoever edits the config decides; there is no notion of a non-admin.
- **Capabilities.** Declared capabilities (`tools.override`, `llm.model_override` and so on) are consented once and
  recorded with a consent hash. An update that adds capabilities asks again. A non-interactive install grants none.
  "Capabilities are a consent and audit layer, not isolation" (`plugins.md:593-655`).
- **Out-of-process mode.** `plugins.isolation: host` runs user plugins in **one separate Python process per
  profile**, started with only that profile's environment and secrets (`plugins.md:894-957`; code
  `hermes_cli/plugin_isolation.py:1-17`, `hermes_cli/plugin_host.py:148` `subprocess.Popen` with an optional
  `launcher` argv prefix for a sandbox runner).
  - Plugins call Hermes only through `ctx`.
  - Surfaces that need live in-process objects are refused with a stated reason: platform adapters, approval
    transports, dashboard auth and others. The list is in `HOST_UNSUPPORTED_CTX_METHODS`, `plugin_isolation.py:39`.
    The same table drives the runtime refusal and the static audit.
  - A crash kills only the host process.
  - To keep users from turning it off, the admin pins it in the root-owned managed scope `/etc/hermes/config.yaml`.
    Enforcement there is "filesystem permissions only" (`managed-scope.md:142`).
  - Per the docs, 299 of 348 catalog plugins run in the host unchanged.

**Code the agent can write and get loaded.**

- **Gateway hooks are "trusted by placement"** (`security.md:1021-1029`, `features/hooks.md:24-32`; code
  `gateway/hooks.py:77` `discover_and_load`). Any `<profile>/hooks/<name>/` folder with `HOOK.yaml` and `handler.py`
  is imported into the gateway when it starts, with no enable list. `HERMES_SAFE_MODE` does not skip it.
  - The file tools' denylist does not cover `hooks/` or `plugins/` (code `agent/file_safety.py:244-320`).
  - `config.yaml` is deliberately writable (issue #45947).
  - So with the default local terminal backend, the agent can write a hook, or write a plugin and enable it in
    config. It runs in-process after the next gateway start. For a secondary profile, hooks load on the first event
    of that profile (`hooks.py:160`).
- **Desktop plugins** (`developer-guide/desktop-plugin-sdk.md:2419-2445`; code
  `apps/desktop/src/contrib/runtime-loader.ts:1-35`):
  - Loaded from `$HERMES_HOME/desktop-plugins/<id>/plugin.js` and hot-reloaded on every save.
  - Enabled by default (`plugins-store.ts:75`, `defaultEnabled = true`).
  - They run with "FULL app authority", which includes the gateway RPC and the native bridge for files, git,
    terminal and installs.
  - Hermes ships a skill (`hermes-desktop-plugins`, `:2498`) so that agents write them.
  - The loader says a remote source "needs a real boundary (iframe/worker + CSP + capability gating)".
- **Dashboard UI plugins** are a `<script>` in the dashboard origin (code `web/src/plugins/usePlugins.ts:196`).
  Their FastAPI routes run in-process unless the plugin host is used.
- **Only Desktop's `::preview` directive is sandboxed** (`desktop-plugin-sdk.md:1150-1156`): an opaque-origin
  `srcdoc` iframe.

**What a non-admin chat user can build.** A chat user can only talk to the profile's agent, which then works with
the profile's tools, credentials and terminal. What the agent produces is per profile, not per person:

- **Skills.** The agent writes skills freely with `skill_manage`, by default with no review (`skills.md:606-670`).
  Optional `skills.write_approval: true` stages every skill write for `/skills approve`. `hermes curator lock`
  freezes one skill.
- **Shared skill directories.** `skills.external_dirs` and `skills.create_dir` can point at a shared "fleet-wide"
  directory. The agent edits skills there in place (`skills.md:424`, `:448-461`).

I found nothing per chat sender: no personal skills, no per-sender model accounts, no per-sender MCP servers or
credentials. Credentials, MCP servers and model accounts are per profile.

**Sharing sessions.** I found no share links (grep for share in the docs and code). What exists:

- **Group chats.** By default each sender gets their own session in a group (`group_sessions_per_user: true`; code
  `gateway/config.py:612`). Turning it off gives one shared session per room. Any member's `/stop` can stop another
  member's run in the same room (`sessions.md:1052-1071`).
- **Operators.** Every verified operator of a profile can attach to all of that profile's sessions. Identities stay
  distinct only for attribution (`sessions.md:29-62`).
- **Export.** `hermes sessions export --format html|md --redact`.
- **Desktop "group chats"** are rooms in which several bots (profiles) talk. They are not rooms of several people
  (`developer-guide/hosted-profile-owners.md`).

## opencode v2: how it works

**Trust model (code).** One server process serves one OS user. Auth is one password, and the username is always
`opencode` (`packages/server/src/auth.ts:18-37`; middleware `packages/server/src/middleware/authorization.ts:61`).
`opencode pair` issues one-time links: 16 random bytes, valid 5 minutes (`packages/server/src/pairing.ts:7`). A link
yields a 30-day session cookie. Changing the password revokes every session (`auth.ts:39-55`, `cli/web.mdx:23`).

Every client (TUI, web, Desktop, mobile app, `curl`) is the same principal. I found no user, principal or role
concept in `packages/core`, `packages/server` or `packages/protocol` (code, grep). `permissions.mdx:184`: "`shell`
runs with the host user's filesystem, process, and network authority". There is no OS sandbox in core.

**The team is the hosted Console (docs only; its source is not in the repo).**

- **Workspaces** (`console/workspaces.mdx`, `members.mdx`, `sso.mdx`, `scim.mdx`).
- **Roles** (`workspaces.mdx:50-52`):
  - **Member**: uses OpenCode and sees their own usage and budget.
  - **Admin**: also manages members, billing, budgets, providers, policies, service accounts and settings.
  - **Owner**: also manages SSO and SCIM, grants Owner, and deletes the workspace.
- **Joining.** People join by email invitation, by SSO on a verified domain (OIDC or SAML) or through SCIM. New
  people always join as Member, and nobody can grant a role above their own.
- **Connecting.** Each member runs their own OpenCode and connects it to the workspace with `/connect`.
- **What the workspace supplies to members:**
  - **Shared models.** Provider keys stay in the Console gateway, so members "use the models without ever seeing the
    provider key" (`console/providers.mdx`).
  - **Budgets.**
  - **Policies.** Each connected client fetches them about once a minute (`policies.mdx` "Console").

  The Console is not a shared agent server. Sessions, tools and plugins all run on each member's machine.

**What a team admin can push (code).** `packages/core/src/config/integration.ts:28-37` and `:70-72` limit the
remote config to four keys: `providers`, `mcp`, `policies` and `websearch`. Per the comment there, "A remote source
can never load plugins, run commands, or change any other local behavior through config". The filtering:

- local (stdio) MCP servers are dropped, because they "would run a command on this machine" (`:115-118`);
- `env` and credentials are stripped from provider settings, because the connection supplies the credential.

**Policies (docs and code).** `policies.mdx` describes statements of the form
`{action, resource, effect: allow|deny}`. The actions are:

- `provider.use`, `tool.use`;
- `integration.connect`, `integration.use`;
- `mcp.use`, `skill.use`, `plugin.use`, `websearch.use`.

Policies "only ever tighten": a `tool.use` allow never grants anything, it only lifts an earlier deny. Broader
authority is evaluated later and wins, in this order from highest:

1. macOS MDM;
2. the system file;
3. the Console;
4. the global file;
5. the project files.

A denied plugin is not loaded (code `packages/core/src/plugin/module.ts:53`). Two built-in plugins cannot be removed
by a repository: the Console connection and the policy plugin (`plugins.mdx:86-89`; code
`packages/core/src/plugin/internal.ts:314` `guarded`). But policies "do not sandbox plugin code"
(`policies.mdx:330`).

**Plugins (code and docs).**

- **Where the server part runs.** It is imported into the server process (`packages/plugin/src/source.ts:29`). The
  other parts:
  - the TUI part runs in the terminal client;
  - the GUI part runs `setup` in every Desktop window, and `main` in the Electron main process "with full access to
    Node.js built-ins" (`build/plugins/gui/index.mdx:36-41`, `:3195-3197`). Desktop takes GUI bundles only from its
    own server, "with a credential that only it holds … A window cannot supply main-process code" (`:204-210`).
- **Where plugins come from.**
  - `plugins` arrays in the global, project and `.opencode/` config files.
  - Automatic discovery of `.ts`/`.js` files and package directories in every discovered `{plugin,plugins}/`
    directory: `.opencode/plugins/` from the working directory up to the root, plus `~/.config/opencode/plugins/`.
    Code: `packages/core/src/plugin/source-directory.ts:7`, `packages/core/src/config/plugin/source.ts:125-136`,
    `packages/core/src/config/discovery.ts:82`.
  - Changes reload automatically (`source.ts:82-93`, `plugins.mdx:125`).
- **Who may install.** Whoever can write a config file or a `.opencode/plugins/` directory, which with one principal
  means anyone holding the password. `opencode plugin add` installs global packages. The only higher authority is a
  `plugin.use` deny from MDM, the system file or the Console.
- **Agent-written plugins.** A file the agent writes to `.opencode/plugins/x.ts` loads into the server with no
  enable step. It is gated only by the agent's `edit` permission on that path, which is `ask` when no rule matches
  (`permissions.mdx:56`). I found no special protection for `.opencode/` in the tool layer (code, grep).

**Agent-written UI (code).** Experimental artifacts are served with `content-security-policy: sandbox allow-scripts`
(`packages/server/src/handlers/artifact.ts:222`), which gives them an opaque origin.

**Non-admin extension.** There is no non-admin on a server. In a Console team, a Member extends their own
installation freely: skills in `.opencode/skills` or `~/.config/opencode/skills`, plugins, MCP servers and
credentials stored locally (`packages/core/src/credential.ts`). The admin's only levers are deny policies and pushed
providers, remote MCP servers and web search.

**Sharing sessions (code).** `services/legacy/README.md:8-9`: "Session sharing was retired in #55716 and V2 has no
sharing". `opncd.ai` now shows a "discontinued" page (`services/legacy/src/share.ts:149-169`). Several clients
attached to one server all see every session.

## What p3 could copy

1. **A per-user plugin host process, from Hermes.** `plugins.isolation: host` is close to item 3 of
   `openclaw-teams.md` and already works:
   - one process per profile, started with only that profile's secrets;
   - an optional launcher prefix for a sandbox runner;
   - `ctx` calls cross by RPC;
   - live facades return plain data;
   - provider objects are proxied by their abstract base class;
   - crashes stay in the host, which restarts with bounded retries.

   Two details to copy. First, **one table of host-refused ctx methods** that feeds both the runtime refusal and
   the static audit, so "the audit says safe" and "it loads" cannot drift apart. Second, refusals carry stated
   reasons. For p3 this is the shape of "a personal plugin's objects run in the creator's host with the creator's
   principal": a list of base surfaces such a plugin may not use, and they fail at load time with a reason.
2. **Team config that carries data, never code, from opencode.** Make instance-pushed resources an allow-list of
   kinds:
   - model providers, with credentials resolved through the connection rather than handed out;
   - remote MCP endpoints;
   - policies.

   Never plugins, and never local commands. In p3 terms, an admin can bring instance resources to users; installing
   code stays a separate admin operation.
3. **Policy layers that only tighten, from opencode.** An `allow` at a lower layer never grants, it only lifts a
   deny. Higher authority (system, then organization) is evaluated last and wins. The policy plugin itself is
   `guarded`, so a lower layer cannot remove it. This fits authz-research's single `decide` with a baseline. The
   `guarded` set is the concrete piece: the policy plugin is not removable by anything below admin.
4. **The main process takes code only from the server, from opencode Desktop.** Only the process holding the
   server credential may fetch code to run, and a window (a client) can never supply it. For p3, the browser never
   sends code for the server or a host to run; code reaches a host only from the installed, admin-approved set or the
   creator's own revisions.
5. **Consent recorded with a hash, from Hermes capabilities.** An update that adds capabilities asks again, and a
   non-interactive install grants nothing. This is the same rule as OpenClaw's grants bound to widget bytes, applied
   to plugin capabilities.
6. **Small pieces:**
   - Answering a permission prompt counts as exercising that permission, so a member cannot approve what they could
     not run themselves (Hermes `security.md:313`).
   - A turn's author is the verified token holder, never a field of the request body (Hermes peer passes).
   - Per-profile secret scope fails closed: a key missing in profile B is never read from profile A (Hermes
     multiplex table).
   - Staged agent skill writes with approve/reject, and per-skill locks (`skills.write_approval`,
     `curator lock`).

## What p3 should avoid

- **Turning a file write into loaded code.** Hermes' `hooks/` folder and opencode's `.opencode/plugins/`
  auto-discovery both turn the agent's file writes into in-process server code. In opencode that takes only an
  approved `edit`; in Hermes, nothing beyond the write and a restart. In p3, installing or enabling a plugin must be
  an explicit operation of its own, never a filesystem side effect inside a workspace the agent can write.
- **Plugins with full app authority loaded from disk and enabled by default** (Hermes Desktop and dashboard
  plugins). Both projects say in their own docs that this is not a boundary.
- **"Signed in" meaning "is the owner"** (Hermes dashboard logins, opencode's single password). This is acceptable
  only while one person uses the server.
- **Calling per-user config directories isolation.** Hermes states that profiles are not tenants; p3 should not
  imply the opposite for per-user state on one host.
- **No sharing at all** (opencode v2 retired it). It is not a model for p3, which needs sessions that several
  people join.

## Comparison

| | OpenClaw | Hermes | opencode v2 |
| --- | --- | --- | --- |
| Multi-user mode | Yes: profiles per person, roles, per-session visibility | No accounts. Allowlisted chat senders, plus an admin/user tier for slash commands per chat scope. Dashboard logins all act as the owner | Server: no (one password). Team = hosted Console (members, Admin/Owner, SSO, SCIM) over each member's own local server |
| Trust boundary | One Gateway = one boundary; roles are guardrails | One OS user = one boundary ("single-tenant"; "profiles are not tenants"); the OS is "the only security boundary" | One server = one user. Between team members: separate machines; the Console pushes only data and policies |
| Who installs server plugins | Admin only (`plugins.install` needs `operator.admin`); workspace plugins disabled until allowlisted | Whoever edits the profile `config.yaml` (`plugins.enabled`). Gateway hooks load just by being placed in the folder | Whoever writes config or `.opencode/plugins/`, i.e. any holder of the password. MDM, system file or Console can deny by name (`plugin.use`) |
| Agent-written code | Skills and scripts in the user's sandbox; widgets in a sandboxed iframe with grants bound to their bytes; no self-loading server code | Skills written freely (optional approval). Hooks, and enabled plugins, load in-process after a restart. Desktop plugins hot-load with full app authority (a shipped skill teaches agents to write them) | `.opencode/plugins/*.ts` hot-loads in-process after an approved `edit`. Artifacts run in a CSP `sandbox allow-scripts` page |
| Non-admin extension | Personal skill library (share, admin promotes); widgets; required per-creator sandbox | None per person; chat users get the profile's agent. Isolation option: per-profile plugin host process | Per member, on their own install: anything. The admin can only deny, and push providers, remote MCP and web search |
| Per-user credentials | Identity-scoped model accounts, pinned per session; personal GitHub | Per profile only (`.env`, credential pools, MCP); none per chat sender found | Each member's local store. Console-shared providers are used through a gateway; members never see the key |
| Session sharing | Shared / Read-only / Suggest / Draft modes; public read-only links | No links. Group chats: one session per sender (default) or one per room. All operators of a profile reach all its sessions. HTML/MD export | None in v2 (retired, #55716). All clients of one server see everything |
