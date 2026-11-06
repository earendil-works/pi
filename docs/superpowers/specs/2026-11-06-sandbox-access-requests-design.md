# Sandbox access requests — design

**Date:** 2026-11-06
**Owner:** Joshua W. Dorsey, Sr.
**Status:** design approved in conversation; revised after the owner's review of nlt-pi#39 (changes requested: bind turn approvals to the originating task, define pending capacity, add governance records); awaiting re-review
**Scope:** `mvp/` (NLT Coding Agent MVP on Vercel, project `nlt-pi-mvp`)

## 1. Intent

The sandbox can reach only a fixed list of hosts (npm, PyPI and GitHub). The owner wants that fixed list replaced as the main control by a question: when the agent needs another site, it asks, and the owner answers.

- **Outcome:** the agent can reach a site it was not pre-approved for, but only after the signed-in owner says yes to that exact site.
- **For whom:** the signed-in owner only (Sign in with Vercel; allow-list `NLT_OWNER_VERCEL_SUBS`).
- **Success:** the agent asks for `example.com`; the chat page shows a card; the owner clicks Allow; the task continues and the sandbox reaches `example.com`. Without a click, it cannot.

### Decisions (owner, 2026-11-06)

| Question | Decision |
|---|---|
| Sites reachable without asking | Keep npm, PyPI and GitHub (the existing presets). Everything else asks. |
| How long an approval lasts | Two buttons: **Allow for this turn** and **Always allow**. Always-allowed sites are stored and can be removed. Deny is not stored. |
| How the agent waits | End the turn on a request, then resume in a new turn (approach B). The turn never waits for a click. |

### Out of scope

- Allow-all. `NLT_AGENT_EGRESS_ALL=1` already exists, is unchanged, and still overrides everything here.
- Wildcard hosts, IP addresses, ports, URLs, or any host named by anything but the agent's tool call.
- Blocking or changing which hosts the *presets* contain.
- Pausing a turn mid-run (approach A, rejected: it holds the sandbox lock and the 270-second budget while waiting and needs polling).
- Giving the agent earlier conversation context. A resumed turn is a fresh session, so the page resends the task.
- Use by anyone but the owner.

## 2. How it works

```
turn 1:  agent -> request_network_access("example.com", "docs for the API")
         server records a pending request bound to this conversation and this task,
         and the turn ends: done { status: "needs_access", access: [{ id, host, reason }] }
page:    card -> [Allow for this turn] [Always allow] [Deny]
click:   POST /api/access { id, decision }      (owner session; the host is looked up server-side)
         "Allow for this turn" answers { nonce }: a one-time continuation secret, shown to nobody
page:    POST /api/agent { conversationId, prompt: <original task + note>,
                           resume: { task: <original task>, grants: [{ id, nonce }] } }
turn 2:  policy = presets + always-allowed hosts + hosts from grants that match
         this conversation, this task and this nonce (consumed atomically, once)
```

A "this turn" approval authorizes exactly one continuation of exactly one task. It is not a capability that any later turn can pick up by id.

## 3. Network policy

The egress list for a turn is computed on the server from three sources and applied by the lifecycle at the start of the turn (it already calls `updateNetworkPolicy` every turn):

1. The presets (`packages`, `git`).
2. The owner's always-allowed hosts (`network_grants`).
3. Hosts from `resume.grants` that match this conversation, this task and the continuation nonce (section 5).

- Hosts are passed through `agentSandboxParams({ egressAllow })`, which already validates every entry. Access requests are stricter: exact hostnames only (no `*.`).
- The list is loaded after the crisis gate passes and before the sandbox is touched, so a blocked prompt never reaches Neon.
- If the lookup fails, the turn runs on the presets alone and logs `access_lookup_error`. It never widens on failure.
- `NLT_AGENT_EGRESS_ALL=1` still wins; in that mode the tool is not registered (nothing to ask for).

## 4. The tool: `request_network_access`

Registered with the sandbox tools only when `NLT_ACCESS_REQUESTS=1`, `DATABASE_URL` is set, and egress is not allow-all. Otherwise the agent behaves exactly as today.

- **Input:** `{ host: string, reason: string }`.
- **Host check:** lowercase; a plain hostname matching the existing domain pattern without a wildcard; at most 253 characters; must contain a letter in its last label (so no IPs); not `localhost`; not already allowed (then the tool answers "already allowed" and records nothing).
- **Reason:** at most 200 characters, control characters removed. It is untrusted text and is only ever shown as plain text.
- **Effect:** inserts a `pending` row, returns text telling the model to stop and wait, and marks the turn to end. The runner stops the session after the tool call and returns `{ status: "needs_access", requests: [{ id, host, reason }] }` plus the assistant text so far.
- **Binding:** the turn must carry a `conversationId` (UUID supplied by the page). Without one the tool is not registered for that turn, because the request could not be bound. The request stores that id and `task_hash`, the SHA-256 of the turn's prompt as received.
- **Limits:** at most 3 requests per turn (extra calls get an error text). At most 10 *live* pending requests per owner: `status = 'pending' AND expires_at > now()`. Expired rows never count (section 5).
- **Tool description (for the model):** "If a command fails to connect to a site you need, call this with the site and why. Then stop; the owner will answer."

## 5. Storage (Neon)

Created on first use with `CREATE TABLE IF NOT EXISTS`, once per process, like chat history. Every statement filters by `owner_sub`.

```sql
access_requests (
  id              uuid PRIMARY KEY,
  owner_sub       text NOT NULL,
  conversation_id uuid NOT NULL,   -- the conversation whose turn asked
  task_hash       text NOT NULL,   -- SHA-256 hex of the asking turn's prompt
  host            text NOT NULL,
  reason          text NOT NULL,
  status          text NOT NULL CHECK (status IN ('pending','allowed_turn','allowed_always','denied','used')),
  nonce_hash      text,            -- SHA-256 hex of the continuation nonce; set only by allow_turn
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
)
network_grants (
  owner_sub   text NOT NULL,
  host        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_sub, host)
)
```

- **Expiry.** A pending request expires 1 hour after it is made. When the owner chooses "Allow for this turn", `expires_at` is reset to 10 minutes after the decision, so the continuation must follow promptly. A row past `expires_at` is never usable, whatever its status. A grant list is capped at 50 hosts per owner.
- **The continuation nonce.** `allow_turn` generates 128 random bits, stores only `nonce_hash`, and returns the nonce once, in the `POST /api/access` answer to the owner's page. It is never logged, never in `GET /api/access`, never in the agent stream, and never stored in plain text.
- **Using a "this turn" approval** is one atomic statement that checks the owner, the conversation, the task and the nonce together:

  ```sql
  UPDATE access_requests SET status = 'used'
  WHERE id = $1 AND owner_sub = $2 AND conversation_id = $3
    AND task_hash = $4          -- SHA-256 of resume.task
    AND nonce_hash = $5         -- SHA-256 of resume nonce
    AND status = 'allowed_turn' AND expires_at > now()
  RETURNING host
  ```

  Two turns racing for the same approval get one row between them. A turn from another conversation, for another task, or without the nonce gets none.
- Before the statement runs, the route also requires that the new `prompt` begins with `resume.task`, so a resume cannot be used to carry a different task.
- An `allowed_always` request needs no nonce: the host is in `network_grants` and is loaded on every turn, by design.
- A grant that matches nothing (unknown, expired, used, denied, wrong conversation, wrong task or wrong nonce) is ignored and logged (`access_resume_ignored`, with the request id and the reason class, never the nonce); the turn still runs on the other sources.
- **Pending capacity and cleanup.** The cap of 10 counts only `status = 'pending' AND expires_at > now()`, so ten requests that expired unanswered never block a new one. When a request is inserted, the same transaction deletes this owner's rows that expired more than 1 day ago, so the table cannot grow without bound. Expired rows younger than that stay, for audit.

## 6. API

All routes follow the chat-history pattern: `Cache-Control: no-store`; 404 when the feature is off; 401 without an owner session; 405 with `Allow` for another method; 503 without `DATABASE_URL` or when the store fails (logging only the operation name).

- `POST /api/access` `{ id, decision }` with `decision` one of `allow_turn`, `allow_always`, `deny`. The id must be a UUID for a `pending`, unexpired request that belongs to the owner; otherwise 404. **The browser never sends a host.** `allow_turn` answers `{ nonce }` (once). `allow_always` also inserts into `network_grants` in the same transaction (409 if the cap is reached).
- `GET /api/access` lists the always-allowed hosts, `{ hosts: [{ host, createdAt }] }`.
- `DELETE /api/access?host=...` removes one always-allowed host (the host is validated like a request host).
- `POST /api/agent` gains two optional fields. `conversationId` is a UUID (the access tool needs it, section 4). `resume` is `{ task: string, grants: [{ id: UUID, nonce: string }] }` with at most 3 grants; `task` is at most 8000 characters like a prompt, and `prompt` must begin with it. Anything malformed is a 400. `resume` requires `conversationId`. It carries ids, the nonce and the original task, never hosts.
- The agent stream's final event gains `status: "needs_access"` with `access: [{ id, host, reason }]`. It carries no nonce.

## 7. Chat page

- On `needs_access`, one card per request: the host in large monospace, the reason as plain text (set with `textContent`), the line "Anything in the workspace can be sent to this site", and three buttons.
- **Allow for this turn:** `POST /api/access`, keep the returned nonce in memory only (never in storage, the URL or the history), then automatically start a new turn: the original task plus a short note that the site is now allowed, the same `conversationId`, and `resume: { task, grants: [{ id, nonce }] }`. The task is resent because a resumed turn has no earlier context.
- **Always allow:** `POST /api/access`, then start the same continuation turn without `resume`; the host is already in the owner's list.
- **Deny:** `POST /api/access` with `deny`; nothing is resent. The card shows "Denied".
- A small "Allowed sites" list (from `GET /api/access`) with a Remove button per host. Hidden when the feature is off.
- Cards and the continuation note are page messages (kind `info`), so chat history does not save them.

## 8. Safety

- **Authority.** A grant exists only because the signed-in owner clicked. Not model output, not a request body, not a stored value the model can write.
- **Prompt injection.** Content the agent reads can tell it to request an attacker's site. The owner sees the exact host and the warning before anything opens. Always-allowed hosts are listed and removable.
- **Exfiltration.** An approved host can receive anything in the workspace; the sandbox holds no credentials, so that is the exposure. Stated on the card and in the README.
- **Fail closed.** Any error loading grants means presets only. Off means unchanged.
- **Gate.** The crisis gate runs on every resumed turn, because it is the same route.
- **Logging.** `access_request`, `access_decision`, `access_resume_ignored` and `access_lookup_error`, with the host and decision where relevant. Never the prompt, the reason or any workspace content.
- **Redirects.** A site that redirects to another host is blocked at the second host; the agent can ask again.

## 9. Testing

- **Unit:** host validation (wildcards, IPs, ports, schemes, `localhost`, uppercase, length); policy composition and de-duplication; owner binding on every query; expiry; caps.
- **Approval binding (the security core):**
  - Replay from another conversation, for another task, with a wrong nonce, with no nonce, after expiry and after use each match zero rows and add no host.
  - Concurrency: two simultaneous consumes of one approval produce exactly one grant (against a real Postgres, not only the recording stub).
  - `resume.task` that is not a prefix of `prompt` is a 400.
  - The nonce appears in no log line, stream event, `GET` answer or stored column other than its hash.
  - An `allow_always` host is available to a later turn in another conversation (by design), while an `allow_turn` host is not.
- **Capacity:** ten expired pending requests do not block an eleventh; ten live ones do; the cleanup removes only this owner's rows older than a day.
- **Route:** check order (404, 401, 405, 503, 400); the host never read from the body; `conversationId` and `resume` shape; stale grants ignored; a turn without `conversationId` has no access tool.
- **Runner:** the tool ends the turn with `needs_access`; no tool and no lookup when the flag is off or egress is allow-all; lookup failure leaves presets only; a blocked prompt never calls the lookup.
- **Page:** card rendering with hostile reason text, button behavior, resend contents, allowed-sites list. A Playwright smoke test with stubbed APIs.
- **Mutation checks** on each rule above (removing the owner filter, the single-use guard, the wildcard rejection or the expiry check must fail a test).
- **Not verifiable offline:** that the real sandbox accepts the added hosts and reaches them. Confirmed by one live turn with the owner after deploy.

## 10. Rollout

1. Merge with `NLT_ACCESS_REQUESTS` unset: no change in behavior.
2. Owner sets `NLT_ACCESS_REQUESTS=1` for production and redeploys.
3. Live check: ask the agent to fetch a page from a site that is not in the presets.

**Governance records.** Because this design defines a security-boundary change, its records are part of this design PR, not deferred to the implementation: a session registration (`docs/agent-log/registrations/`), an intent record (`docs/agent-log/intent/2026-11-06-sandbox-access-requests.md`), a handoff (`docs/agent-log/handoffs/2026-11-06-sandbox-access-requests-design.json`), and the thread `NLTPI-MVP-007` in `docs/active-threads.md`. The implementation PR adds its own intent record before code, updates the thread and writes a new handoff. The README's Network paragraph and platform table are updated then.

**Layering.** This is an AgentOS execution and egress design with owner authorization. The sandbox is not an authorization authority: it only enforces the policy the server computes from the owner's decisions. The design does not touch the ASFDK development, foundation, harness or MCP layers, and the crisis gate still runs before any lookup.

## 11. Known limits

- The agent asks only if it chooses to. It cannot detect a blocked connection on its own, and a weak model may fail without asking.
- A resumed turn is a new session; only the sandbox files carry over.
- `example.com` and `www.example.com` are different hosts, so a site may need two approvals.
