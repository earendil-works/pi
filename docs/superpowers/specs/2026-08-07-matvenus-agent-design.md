# MatwingsVenus Agent — Design Spec (Phase 1)

**Date:** 2026-08-07
**Status:** Approved (design); pending implementation plan
**Scope:** Phase 1 — rebrand + auth gate, delivered in the terminal TUI. Phase 2 (Electron GUI) is outlined at the end but out of scope for this spec.

---

## 1. Goals & Non-Goals

### Goals
1. **Rebrand** the pi coding-agent into **matvenus**: the CLI command becomes `matvenus`, the agent refers to itself as `matvenus` (system prompt, help, headers), config lives under `~/.matvenus`.
2. **Login gate**: the agent cannot be used until the user authenticates against the MatwingsVenus backend (JWT). Auth is a **pure access gate** — it does NOT touch model traffic; after login the agent still uses vendor API keys (`ANTHROPIC_API_KEY`, etc.) as today.
3. **Full login UX**: password and verification-code login, account selection (multi-identity), and **post-login binding** (phone/email) — matching the `matwingsvenus-web` contract.
4. **Custom welcome banner**: a MATWINGS/VENUS ASCII banner + branding on startup.

### Non-Goals (this spec)
- The **Electron GUI** (Phase 2). The auth core is designed to be reused by it, but no GUI is built here.
- Routing model traffic through the MatwingsVenus backend (login is gate-only).
- npm republishing under a new scope (package name stays; only `bin` changes).
- Self-update infrastructure (`pi-mono` release URLs) and pi.dev phone-home (version-check / install telemetry) — **disabled**, not redirected.
- Responsive ASCII scaling; post-login binding-gate UI beyond the mandatory flow.

### Phasing
- **Phase 1 (this spec):** rebrand + auth (gate/login/logout/binding) + backend integration + welcome banner, working in the terminal TUI. Immediately usable, gated, rebranded.
- **Phase 2 (future, separate spec):** Electron desktop app driving the agent via the in-process SDK (`createAgentSession`), reusing the Phase-1 auth core, with a graphical welcome.

---

## 2. Rebrand — Config-Driven + Hardcoded Sweep

### 2.1 Single-source config changes (`package.json`)
Setting `piConfig.name` propagates to `APP_NAME`/`APP_TITLE`/`CONFIG_DIR_NAME` automatically (`packages/coding-agent/src/config.ts:487-491`).

| Item | New value | Location |
|---|---|---|
| `piConfig.name` | `matvenus` | `packages/coding-agent/package.json:8-9` |
| `piConfig.configDir` | `.matvenus` | `packages/coding-agent/package.json:8-9` |
| `bin` | `{ "matvenus": "dist/cli.js" }` | `packages/coding-agent/package.json:10-11` |
| → `APP_NAME` | `matvenus` | `config.ts:489` (auto) |
| → `APP_TITLE` | `matvenus` (was `π`) | `config.ts:490` (auto) |
| → `CONFIG_DIR_NAME` | `.matvenus` | `config.ts:491` (auto) |
| → `getAgentDir()` | `~/.matvenus/agent` | `config.ts:515-521` (auto) |
| → env var prefix | `MATVENUS_CODING_AGENT_DIR`, etc. | `config.ts:494-496` (auto) |
| npm `name` | **unchanged** (`@earendil-works/pi-coding-agent`) | `package.json:4` |

### 2.2 Hardcoded literals to sweep (do NOT auto-propagate)
1. **System-prompt self-name** `src/core/system-prompt.ts:121-138` — "operating inside pi…" → `matvenus`. **Highest priority** (how the model names itself).
2. **CLI text** `src/cli/args.ts:228-418` (literal "pi" prose in `printHelp`), `src/cli/auth-command.ts:18-44` (`pi auth` usage), `src/main.ts:70` (`"pi -ne"` hint) → route through `${APP_NAME}`.
3. **Provider HTTP headers** `src/core/provider-attribution.ts:47,54,60,76` — `User-Agent: pi-coding-agent`, `X-OpenRouter-Title: pi`, `X-BILLING-INVOKE-ORIGIN: Pi`, `x-opencode-client: pi` → `matvenus`.
4. **User-Agent** `src/utils/pi-user-agent.ts:3` — `pi/${version}` → `matvenus/${version}`.
5. **Experimental subcommand** `src/cli/experimental/commands/pi.ts` — `command: "pi"` → `"matvenus"`.
6. **Official-distribution triple** `src/cli/startup-ui.ts:26-42` — `OFFICIAL_PACKAGE_NAME/OFFICIAL_APP_NAME/OFFICIAL_CONFIG_DIR_NAME` hardcoded `pi`/`.pi`; sync to the new triple or `isOfficialDistribution()` breaks and first-time-setup is silently skipped.
7. **pi.dev phone-home — DISABLED**: `src/utils/version-check.ts:5` (`pi.dev/api/latest-version`) and install telemetry `src/modes/interactive/interactive-mode.ts:1207` (`pi.dev/api/report-install`) → no-op for the fork (no "pi update available" prompts, no telemetry to pi.dev).
8. **Misc literals** `interactive-mode.ts:949-950,1161,4722` ("Pi can explain…", "Restart pi…"), `first-time-setup.ts:29,56`, `README.md` → update/correct.

### 2.3 Sub-decisions
- **npm package name: unchanged.** Local/global install only depends on `bin`; `npm i -g .` yields the `matvenus` command. Renaming the scope needs npm ownership and breaks pi-extension compatibility.
- **pi.dev phone-home: disabled** (not redirected).
- **Self-update infra: out of scope.** `update`/`pi-mono` release URLs left as-is; not expected to work for the fork.

---

## 3. Auth Module — `packages/coding-agent/src/core/matwings-auth/`

Reimplemented in Node (the web code is browser-coupled: `document.cookie`, `crypto.subtle`, `import.meta.env` — not reusable). **The core is TUI-agnostic** (no `pi-tui` imports) so Phase 2's Electron reuses it; only the login *screen* is a thin TUI adapter.

### 3.1 Structure
| File | Responsibility |
|---|---|
| `config.ts` | Backend URL: `process.env.MATVENUS_BACKEND_URL ?? "https://test.matvenus.com/test"`; API prefix `/api`. No HTTPS enforcement (allow localhost http). |
| `crypto.ts` | RSA-OAEP-SHA256 password encryption via `node:crypto.publicEncrypt({key, padding: RSA_PKCS1_OAEP_PADDING, oaepHash:'sha256'})` → base64 → prefix `enc:`. Used for **both** login password and bind `current_password`. |
| `client.ts` | HTTP (global `fetch`/undici). `fetchPublicKey`, `loginPassword`, `sendVerificationCode`, `loginWithCode`, `selectAccount`, `getProfile`, `renew`, `signOut`, `getSystemFeature`, `sendBindCode`, `bindAccount`. Sets `Accept-Language`. Maps FastAPI `detail`/`error_code` → friendly messages (subset of web `auth-errors.ts`). |
| `storage.ts` | Token persistence at `~/.matvenus/agent/matwings-auth.json`, `0o600`, reusing pi's file-lock pattern (`src/core/auth-storage.ts:47-202`). **Separate file** from provider `auth.json`. `loadTokens/saveTokens/clearTokens`. |
| `session.ts` | Facade: `isLoggedIn()`, `ensureValidToken()` (refresh within 10-min buffer), `requireAuth()`, `login()` orchestration, `logout()`, `runBindingIfRequired()`. |
| `index.ts` | Re-exports. |

### 3.2 Token storage shape
`{ access_token, refresh_token, expires_at: <epoch ms>, user }`. Refresh buffer = 10 min (matches web `REFRESH_BUFFER_MS`).

### 3.3 Backend API contract (base + `/api`)

**Auth / login**
- `GET /api/auth/password-public-key` → `{ public_key_pem, fingerprint, algorithm: "RSA-OAEP", encrypted_prefix: "enc:" }` (public, no auth).
- `POST /api/user/login` `{ identifier, password: "enc:<b64>" }` + `Accept-Language` → `SignInRes | AccountSelectionRes`.
- `POST /api/user/login/select` `{ selection_token, selected_user_id }` + `Authorization: Bearer <selection_token>` → `SignInRes`.
- `POST /api/user/send-verification-code` `{ identifier, purpose: "login" }`.
- `POST /api/user/login-with-code` `{ identifier, code }` → `SignInRes`.
- `GET /api/user/profile` + Bearer → 200 (authed) / 401 (not).
- `POST /api/user/renew` `{ refresh_token }` → `SignInRes`.
- `POST /api/user/sign-out` + Bearer.
- `GET /api/system/feature` → `{ force_phone_binding, force_email_binding, … }`.

**Binding**
- `POST /api/user/send-bind-code` `{ identifier, purpose: "bind", language_code? }` + Bearer → `{ success, message, identifier_type }`. 60s resend throttle; code 6 digits, valid 5 min.
- `POST /api/user/bind` `{ identifier, code, current_password: "enc:<b64>" }` + Bearer → `UserResponse` (phone/email now set). No new token, no re-login.

**Response shapes**
- `SignInRes = { access_token, refresh_token, expires_at: ISO8601, token_type: "bearer", user, binding_required?: boolean, binding_type?: "phone"|"email"|"any"|null }`.
- `AccountSelectionRes = { requires_account_selection: true, selection_token, accounts: [{ user_id, name, account_type, org_name, avatar }] }`.
- `binding_required` is advisory; **mandatory** is computed client-side from `/system/feature` force flags + whether the profile lacks the field.

**Validation** (client-side, pre-submit): phone `^1[3-9]\d{9}$`, email `^[^\s@]+@[^\s@]+\.[^\s@]+$`, code exactly 6 digits, password non-empty.

### 3.4 Sub-decisions
- **Binding: implemented** (not skipped). Mandatory binding enforced; cancel ⇒ logout (matches web). Non-mandatory ⇒ prompt "bind now? y/n", skippable.
- **Token storage: separate file** `~/.matvenus/agent/matwings-auth.json` (isolated from provider creds).
- **Error mapping: subset** of web `auth-errors.ts` (bad credentials, bad/expired code, rate limit, network unreachable).
- **RSA: `node:crypto`** (cleaner than WebCrypto; native in Node 24).

---

## 4. Gate + Login / Logout / Binding Flow

### 4.1 Gate insertion point
In `packages/coding-agent/src/main.ts`, **after** the `--help`/`--list-models` short-circuit (~L854-866) and **before** mode dispatch (~L923). This:
- **Exempts** `--version`, `--help`, `--list-models`, `matvenus auth`, `matvenus login`, `matvenus logout`, `matvenus config`, `matvenus install/…` (all return before this point).
- **Gates** interactive, print, and rpc modes (all real agent usage).

Gate logic: `isLoggedIn()` → pass; access expired + refresh present → `renew` → pass; else run login flow; on failure, exit non-zero.

### 4.2 Top-level subcommands (parsed early, exempt from gate)
- `matvenus login` — run login (password/code), store token, run binding if required, print success. Reuses the gate's login code.
- `matvenus logout` — best-effort `POST /user/sign-out`, clear tokens.
- Distinct namespace from `matvenus auth` (provider) and `/login` slash command (provider OAuth) — no clash.

### 4.3 Login flow (terminal screen)
1. Gate detects no valid token → enter login.
2. Login screen built on pi **startup-ui / pi-tui** primitives (same theming as first-time-setup). Collects: mode (password/code) → identifier → (masked password | code).
3. Passwords and bind `current_password` encrypted via `crypto.ts`.
4. `AccountSelectionRes` → account selector; else store `SignInRes` tokens.
5. On success → binding flow → welcome banner + TUI.

### 4.4 Binding flow (terminal)
On `binding_required`: `GET /system/feature` → compute `mandatory`:
- **mandatory**: must bind; cancel ⇒ logout.
- **non-mandatory**: prompt "bind now? y/n"; skip if no.
- Flow: choose channel (phone/email; `any` ⇒ user picks, default phone) → collect identifier → `send-bind-code` (60s throttle) → collect 6-digit code + current password (masked + RSA) → `bind` → update profile. No token swap, no re-login.

### 4.5 Sub-decisions
- **Login screen: pi-tui primitives + masked password input**; fall back to `readline` if masking unsupported (impl risk to verify early).
- **Mandatory binding cancel ⇒ logout** (web parity).
- **Auth core kept TUI-agnostic** for Phase 2 reuse.

---

## 5. Welcome Banner (terminal ASCII, Phase 1)

### 5.1 Placement
Replace the TUI header block at `src/modes/interactive/interactive-mode.ts:908-967` (current logo + instructions + onboarding) with:
- **MATWINGS** ASCII (top) + **VENUS** ASCII (bottom)
- `v1.0.0-beta • AI4Science Engine Active`
- `Welcome to MatwingsVenus. The SAION AI Scientist is ready.`
- `Type /help to see available commands, or /exit to quit.`

Rendered as an `ExpandableText` (collapsible; expanded on first view). Interactive mode only (print/rpc have no UI).

### 5.2 Branding constants
New `src/core/branding.ts`: `DISPLAY_VERSION = "v1.0.0-beta"`, tagline `AI4Science Engine Active`, the ASCII line arrays, `MatwingsVenus`, `SAION AI Scientist`. `DISPLAY_VERSION` is **decoupled** from the npm version (`0.84.0`).

### 5.3 Sub-decisions
- **`[matwings] ❯` is NOT reproduced** as an input prefix — pi's bordered multi-line editor is retained (prior decision). The banner shows text/ASCII only.
- **Banner replaces the header block**, collapsible.
- **ASCII width 74 chars**, left-aligned, no responsive scaling (YAGNI).

---

## 6. File-Level Change Summary

**New files**
- `packages/coding-agent/src/core/branding.ts`
- `packages/coding-agent/src/core/matwings-auth/{config,crypto,client,storage,session,index}.ts`
- `packages/coding-agent/src/cli/matwings-login-command.ts` (login/logout parsing, near `runAuthCommand`)
- A TUI login screen component (startup-ui based; exact path TBD in plan)

**Modified files**
- `packages/coding-agent/package.json` (bin, piConfig)
- `src/config.ts` (no change needed — auto-propagates; verify)
- `src/cli/startup-ui.ts` (OFFICIAL_* triple)
- `src/core/system-prompt.ts` (self-name)
- `src/cli/args.ts`, `src/cli/auth-command.ts`, `src/main.ts` (literal "pi"; gate + subcommand wiring)
- `src/core/provider-attribution.ts`, `src/utils/pi-user-agent.ts`, `src/utils/version-check.ts` (headers/UA; disable pi.dev)
- `src/modes/interactive/interactive-mode.ts` (banner header; disable install telemetry; literals)
- `src/modes/interactive/components/first-time-setup.ts`, `src/cli/experimental/commands/pi.ts`, `README.md`

---

## 7. Testing
- **crypto**: encrypt against a known RSA key; assert `enc:` + base64 + backend-decryptable shape.
- **client**: mock `fetch` per endpoint; assert payloads, response-type guards (SignInRes vs AccountSelectionRes), error mapping.
- **storage**: temp-dir round-trip; `0o600` perms; concurrent-lock behavior.
- **session/gate**: token-valid pass; expired→renew pass; renew-fail→login; mandatory-binding cancel→logout.
- **binding**: send-code throttle; bind success updates profile.
- **rebrand smoke**: `matvenus --version`/`--help`/`--list-models` run without login; `matvenus` (no token) → login screen; banner renders in interactive.

---

## 8. Assumptions & Open Items
- **Backend base URL**: `https://test.matvenus.com/test` with `/api` prefix ⇒ login at `…/test/api/user/login`. **Confirm the API is mounted with the `/api` prefix; if it's directly under `/test`, drop the prefix.**
- **Backend reachability** assumed from the CLI's environment.
- **`piConfig.name` behavior** verified against `config.ts:487-491` (APP_TITLE becomes `matvenus`, not `π`, once `piConfig.name` is set).
- **Masked password input** in pi-tui — verify early; fallback to `readline`.

---

## 9. Phase 2 Outline (Electron GUI — future spec)
- New Electron app (new package or repo). Main process (Node) calls `createAgentSession()` from `@earendil-works/pi-coding-agent` (in-process SDK, zero IPC).
- **Reuses the Phase-1 `matwings-auth` core** unchanged: runs `requireAuth()` in the main process before creating a session.
- GUI login window replaces the TUI login screen; graphical welcome replaces the ASCII banner.
- pi's RPC extension-UI sub-protocol (permission dialogs, status, widgets) informs the GUI's tool-call/permission UX.
- Provider keys still configured inside the agent process (`matvenus auth` / env) — unchanged by Phase 2.
