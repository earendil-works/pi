# OpenClaw's team mode, and what p3 can take from it

Research note, 2026-11-14 (subagent "openclaw-teams"). Source: `github.com/openclaw/openclaw` at `c19ae286`
(2026-11-14), shallow clone in `/tmp/openclaw`. Doc paths are under `docs/`; the same pages are on
`https://docs.openclaw.ai/<path without .md>`.

## Short answer

OpenClaw does not solve the problem. It avoids it. Server code stays admin-only. Non-admins extend the system with
things that are not server code: instructions, scripts that run in the user's sandbox, and HTML that runs in an
iframe. Every one of these is owned by a person, versioned and shareable.

## How it works

**Trust model.** One Gateway (OpenClaw's server) is one trust boundary, meant for "a single operator or a mutually
trusting team". Hostile users need separate gateways. Roles are "collaboration guardrails, not tenant isolation"
(`gateway/security/trust-model.md`, `start/multiplayer.md` "One trust boundary"). Ownership, presence and drafts are
"usability features, not security boundaries" (`concepts/multi-user.md`).

**Identities.** Each person signs in through Tailscale Serve, Cloudflare Access or OIDC (a trusted proxy) and gets a
durable Gateway profile. GitHub sign-in is verified, and duplicate profiles can be merged. A shared token gives one
"Owner" profile for everybody. Once roles are configured, device tokens without a verified person are refused
(`gateway/operator-scopes.md` "Named operator roles"). Channel senders (Slack, Discord and so on) are a separate
identity domain, gated by pairing and allowlists, and are never matched to profiles by ID
(`gateway/security/access-control.md`).

**Roles.** These are set in `gateway.roles` config. Each role has:

- a scope ceiling: `operator.sessions.read/write`, `read`, `write`, `cron`, `approvals` or `admin`;
- `sessions.others` (`none`, `view`, `suggest` or `write`) for sessions other people created;
- an allowlist of agents;
- `modelPolicy` (allowed and denied models);
- `sandbox: "required"`;
- an optional `accessPolicyPlugin`, for example Visitor Access for invited guests with an expiry.

Roles are assigned with `users.setRole` (admin only) or by GitHub login. Each RPC method declares its scope in
`src/gateway/methods/core-descriptors.ts`.

**Admin-only.** These methods require `operator.admin`:

- `plugins.install` (line 412);
- `config.set/patch/apply`, which covers MCP servers (`mcp.servers`), roles and shared credentials;
- `skills.install` and `skills.upload.*`, which install into the shared skill set;
- `skills.proposals.apply`;
- `users.linkAuthProfile`, which attaches a shared model credential to a person;
- `secrets.*`.

Native plugins "run in-process with the Gateway. They are not sandboxed … equivalent to arbitrary code execution"
(`plugins/architecture.md` "Execution model", `gateway/security/tool-permissions.md` "Plugins"). Workspace-origin
plugins, meaning code an agent could drop into its workspace, are disabled until an admin enables or allowlists them
(`tools/plugin.md`). So an agent cannot write server code that loads itself.

**What a non-admin (`operator.write`) can do.**

- **Personal skill library** (`skills.library.save/import/mutate` = `operator.write`; `tools/skills.md` "Personal
  skills on a shared Gateway", `tools/skill-workshop/personal-library.md`). A skill is a `SKILL.md` plus scripts and
  assets, saved as an immutable revision addressed by content hash. The agent writes it with the `skill_library`
  tool, and the requesting human owns it. That person can **Share with team** (others use it but cannot edit it).
  Only an admin can **transfer to team**. Sessions pin skill revisions, so another person joining a session does not
  swap its skills. Limits: 256 files and 8 MiB per skill. Writes require a live, authenticated human turn; cron jobs
  and child runs cannot write. The library "does not grant new tools, credentials, host installation rights".
  Scripts run only through the session's own exec tool, so a guest's scripts run in that guest's sandbox.
- **Agent-written UI** (`tools/show-widget.md`, `web/dashboards.md`). A widget is HTML/JS rendered in a double
  iframe with an opaque origin, served from a separate sandbox hostname, with a restrictive CSP. Widget scripts
  cannot reach the Control UI or the Gateway directly. To do more, a widget declares capabilities:
  - `net`: exact HTTPS origins;
  - `data`: named read bindings that the Gateway resolves, so the widget never holds a token;
  - `actions`: plugin action verbs;
  - `cron.trigger:<id>`;
  - `prompt`.

  The session's permission mode (Full, Auto-review by an AI reviewer, Ask, or Read only) grants or refuses these.
  **A grant is bound to the exact widget bytes.** Changed bytes need a new decision.
- **Required sandbox per creator** (`gateway/operator-scopes.md`, around line 520). Each guest gets their own
  Docker/Podman container and workspace, shared across that guest's sessions. There is no network by default and no
  fallback to running on the host. A shared workspace mounted `rw` is downgraded to `ro`, so it cannot become a
  bridge between guests. Child sessions inherit the requirement. The docs list what the sandbox does *not* contain:
  - Code Mode's default `node:vm` executor ("not a security boundary"). The QuickJS-WASM executor is the isolated
    option (`tools/code-mode/executors.md`).
  - CLI backends such as Claude CLI.
  - cloud workers, which receive the shared GitHub identity.
- **Per-person resources.**
  - Model accounts: stored in identity-scoped records, never in the shared auth store, and pinned to the session
    when it is created (`concepts/multi-user.md` "Per-person model accounts").
  - Personal `users/<profile>/USER.md` instructions.
  - A personal GitHub connection.
  - Owned cron jobs.

**Shared resources.** Agents, plugins, MCP servers, tools and the shared credentials and GitHub account are
configured by an admin and used by everyone. Guest pull requests go out through the shared account. The
recommendation is to point `origin` at a fork so CI secrets are not exposed.

**Sharing sessions.** A session records three things: an immutable creator (the anchor for sharing authority), an
assignable owner and a participant history. Each session has a visibility mode: Shared, Read-only, Suggest or
Draft. Drafts are still visible to admins. The creator or an admin can turn on public read-only links. Session tools
reach every session on the Gateway by default (`tools.sessions.visibility: all`). The Session Share plugin exposes
another Gateway's sessions read-only.

## What p3 could copy

1. **Say the boundary out loud.** The p3 decision of 2026-11-11 already accepts that "a guest who may send can
   already have the agent run `bash`". OpenClaw draws the same line and still keeps in-process code admin-only. If
   p3 keeps "plugins are server code", only admins can install them, the same as in OpenClaw.
2. **Sort what an agent builds by where it runs, not by what it is.**
   - Instructions and scripts are per-user, owned by a profile and need no admin (OpenClaw's skill library).
   - UI with declared capabilities runs in a sandboxed iframe, needs no admin, and its grants are tied to its bytes
     (OpenClaw's widgets). This answers "a non-admin's agent builds a board". It is close to p2's sandboxed HTML views
     plus a capability manifest. The `data` and `actions` bindings are typed contracts that the server resolves for
     the viewer.
   - In-process server code stays admin-only.
3. **Personal plugins, run outside the server process (p3 would go further than OpenClaw).** An agent-written plugin
   is owned by its creator, saved as content-hashed revisions, and runs in a per-user host. That host is a separate
   process, container or isolate, like OpenClaw's per-creator required sandbox, never `node:vm`. The plugin's
   objects run with the creator's principal and role ceiling. They can serve only the creator's resources and the
   sessions the creator brings them into. They get no instance scope and no hooks into the base.
   - **Share** lets others use the plugin without editing it.
   - **Promote to instance** is an admin review of one exact revision, like OpenClaw's transfer-to-team,
     `skills.proposals.apply` and Workshop `propose` mode. Grants stay bound to that revision hash.

   This is what lets non-admins write multiplayer plugins without trusting them with the server. It needs Chord to
   host one user's objects in a separate process; whether that already exists has not been checked.
4. **Small pieces worth copying as they are:**
   - pin revisions per session, so another participant cannot change a session's code underneath it;
   - personal credentials go into identity-scoped storage, never into the shared store, and the session pins the
     account used;
   - a role ceiling that only narrows, never grants;
   - authority can be revoked live (connections close when a role changes);
   - only a live, authenticated human turn may publish personal code (no cron jobs or child runs);
   - sandbox requirements are inherited by child sessions and cannot be removed afterwards.
