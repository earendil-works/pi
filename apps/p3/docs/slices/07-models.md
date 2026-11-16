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
