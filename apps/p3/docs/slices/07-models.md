# Slice 7: Models

**Goal.** Real providers and their sign-in flows (OAuth, keys), the models a session may use, usage. p2's `plugins/models` as precedent.

**Depends on:** slice 3.

**From the archive:** `archive/base-inventory/explainer/book.md` (The Harness: model providers; What Is Offered); `archive/status-2026-11-09.md` §3 (models as providers).

**Read first:** `decisions.md` ("Models and credentials"); design.md §20 (sign-in as a flow kept by its owner) and §24 (`HarnessModels`); `archive/accounts/book.md` (Stored on the Server, Used Elsewhere, Models); `archive/base-inventory/merged.md` #5 and #13; p2's `plugins/models/`, `plugins/login/`.

The brief is filled out when the slice is next.

**Also read (docs audit, 2026-11-14; "Chord dec." is `packages/chord/docs/decisions.md` by entry title and line, "archive" is `../archive/`, "research" is `/home/badlogic/chord-notes/research/p3-people-2026-11-13/` on slayer):**

-  `accounts/book.md` (Stored on the Server :337, Models :442); `resources-code/book.md:141-217`;
  `handoff.md:76-77`; `model-stress/report.md:829-863`; `resource-model/book.md:1393-1397` (Bedrock/Vertex);
  `map/book.md:290-295`; `merged.md` §2 #5 (model wraps cover pi-ai callbacks).
- **source:** `packages/ai/src/auth/types.ts`, `packages/ai/src/models.ts`; p2 `plugins/login/`,
  `plugins/cache-warming/`, `src/runtime/settings.ts` (defaultModel).

**Open or to carry (docs audit):**

- Credentials by reference, never copied (from the withdrawn org entry); delivery kinds `pushed` (with an expiry; pi-ai's
  `AuthResult` has none), `signing` (an ssh-agent bridged over Chord, the key stays on the server), `server-only`
  (`archive/model-stress/report.md` 829-850).
- Accounts for third-party integrations (`archive/accounts/book.md`: `Accounts`, `AccountProviders`,
  `AccountCredentials`): no plugin owns accounts in the overview yet.
- A word for a provider's login (names.md's sign-in means a signed-in device).

## Worker memory: what to build with models (owner, 2026-11-16)

Measured by mem-audit on a realistic session worker (the Durable harness with coding tools, pi-ai with the Anthropic
and OpenAI SDKs against a local HTTPS stub, telemetry), release layout, without the glibc setting; private:
`/home/badlogic/chord-notes/research/p3-memory.md` (sections on the realistic worker and the levers), scripts in
`/tmp/memprobe` and `/tmp/pi-snap2` on slayer (temporary). USS, MiB:

| | today | with the levers below |
| --- | --- | --- |
| idle after start, before any request | 25.8 | 25.8 |
| after the first response | 45–47 | about 30 |
| after a burst of 20 turns | 49–51 | about 35 |

Where the first request's +20 MiB goes: Node's HTTP client (undici's JS, the llhttp WebAssembly, its optimized compile
leaving about 7 MiB of native memory, TLS) about 12; the provider SDKs 5–6 (each loads whole); compiled code of the run
path about 4; data under 1.

**To build (decided):**
1. **Session workers run with `--wasm-tiering-budget=2000000000`** (V8 does not optimize llhttp's WebAssembly): −8 MiB
   per worker after the first request (−6.5 with npm undici's `EnvHttpProxyAgent`), no CPU cost measured; the first
   request of a process takes about 20 ms longer. Set in the worker's `execArgv` (`src/install.ts`), when the harness
   arrives (slice 3), and measured again there.
2. **With `--optimize-for-size`:** together about −10 MiB after a response and −22 MiB at a burst's peak, for about 4%
   more CPU per turn. Same place, same measurement.
3. **The SDKs are bundled into the worker base** instead of loaded from `node_modules`: another −4 to −5 MiB, no cost
   at run time. Chord's worker base leaves every `node_modules` package external today (design §23, "The worker
   base"), so this needs a Chord option naming packages to bundle: a Chord decision of its own, in this slice.

**Kept:** npm undici as coding-agent configures it (`packages/coding-agent/src/core/http-dispatcher.ts`: proxies,
idle timeouts, connection attempts, the error listener); a `fetch` over `node:https` was ruled out for it.
**Not done:** narrower SDK imports (no saving: each client constructs every resource); pi-ai without the SDKs (500 to
700 lines for −1 to −6 MiB); a shared process making all provider requests (each turn would carry the whole context,
images included, through one more encode and decode).
