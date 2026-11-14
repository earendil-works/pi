# p3: state at the end of 2026-11-13 (for a handoff)

Written by the p3 session (8b6ab5cc) so a new context can resume. Nothing below is built unless marked.

## Read first, in full (in this order)

1. `apps/p3/docs/status-2026-11-13.md` (this file).
2. `packages/chord/docs/admission/design.md` (Chord admission before the factory: the access core).
3. `apps/p3/docs/locks/design.md` (locks: what a Pi, app, session gets).
4. `apps/p3/docs/people/book.md` (second edition; its principal/stamps/session-check parts are superseded by admission
   and the identity-only principal, see below; identity, joining, apps, kit changes, club example still relevant).
5. `apps/p3/docs/decisions.md` (all; the last entries are today's).
6. `packages/chord/docs/design.md` in full (3,408 lines; current with code as of 827383a15).
7. `apps/p3/docs/org-managed/book.md` (enrollment, gate, machine lock-down; settings layer superseded).
8. `apps/p3/docs/base-inventory/explainer/book.md` chapters "The Harness", "What Is Offered", "Waiting Costs Nothing".
9. `apps/p3/docs/views.md`, `apps/p3/docs/sharing.md`, `apps/p3/docs/apps/web-ui-direction.html` (apps mockup).
10. Reviews: `/home/badlogic/chord-notes/research/p3-people-2026-11-13/` (apps-*, org-*, choose-*, admission-review-*),
    plus `/tmp/admission-review2-adm-fable.md` and `/tmp/locks-review-adm-fable.md` when Fable finishes.
11. Code for building: `packages/chord/src/host/attempt.ts`, `object.ts`, `dependencies.ts`, `parked.ts`,
    `staging.ts`, `revocation.ts`, `reference.ts`, `reference-source.ts`, `remote/hold.ts`, `remote/provider.ts`,
    `node/app/sign-ins.ts`, `pairing.ts`, `invite.ts`, `users.ts`, `app.ts`, `worker.ts`; p2 precedents
    `apps/p2/src/runtime/principals.ts`, `session-lock.ts`, `tool-access.ts`, `durable.ts`, `apps/p2/plugins/sharing/`.

## Decided today (owner, 2026-11-13)

**Direction**
- One Pi per person, one owner who installs every plugin; plugins (apps among them) are trusted code; only people are
  confined. Colin's plan: Dec 1 Pi Roam, Dec 18 Org Devices (each member their own Pi on an org machine), Feb hosted.
- Pi must be "super malleable, with basic primitives that allow almost everything": keep cheap extension points.

**Apps**
- An app is a plugin: its layouts, views, objects; reuses any other plugin's. Coding is the built-in app.
- A session belongs to exactly one app; any app may show any session; moving a session to another app is allowed (its
  app is a fact admissions read live). `defaultApp` (Pi setting; per person a preference): new sessions without a
  choice and the start page go there; fallback coding.
- Apps can admit other apps' people (the robot lets family members read).

**People and access**
- Principal is identity only: `{ kind: "owner" }`, `{ kind: "person", id, name }`. Roles, shares, private sessions
  are app/plugin data read by admissions. (Superseded today: per-app user pools, `self.choose`, stamps, session lists
  in the principal, string-encoded session ids, revision bumps on role changes.)
- Identity is pluggable: identity-provider registries stay (server; web button; terminal flow optional, pairing code
  default); built-in providers Radius (verified email; Google/GitHub at Radius) and device; more devices by pairing.
- No defensive machinery against the owner (he passes everything; privacy from him is an app's UI courtesy).
- A session's agent reaches other sessions only as its session's lock `conversations.reach` allows (no inherited
  rights from creator or sender).

**Chord: admission before the factory** (design committed, a309480a7; reviewed by Opus, Astra, Sol, Fable: "fits with
changes", folded in)
- `host.serve(Type, factory, { admit })`; `admit` declares references/registries/derives, returns
  `Readable<allow(level) | deny(reason)>`; the factory gets the level (a string).
- Object identity unchanged; each attempt is admitted then built; deny → `failed { denied }` (getters reject at once,
  holders and dependents wait and heal); a change or an unhealthy source seals the attempt at once (no grace) and a
  new attempt is admitted; holders re-bind (another variant); presence lists only admitted holders; denied holders lose
  last values; staging runs the new `admit` and rehearses the factory with the current level; wire unchanged except
  the per-ack binding fence (`remote/hold.ts #bindTo`, needed anyway).
- p3 use: `SessionsStore.facts` (keyed, server), `SessionAccess { session, person }` (server, held by the session's
  worker, the person as data), apps' `access` rules contributed as writables that change with their data.
- Open for the owner: staging rule (Fable's recommended), drop last values on deny (recommended), route stays coarse
  (recommended).

**Locks** (design committed, 3e5a6c1eb + 6de6f44bb; under Fable's review)
- A plugin declares a lock (`defineLock`: id, `title`/`description` as `MessageData`, version, schema, open, closed,
  `narrow`, `migrate`; built-ins switch, allow/deny globs, maximum), registers it (`Locks`), reads it (`lockValue`,
  `lockValueFor`), enforces it where it hands things out. Static declarations; runtime things are values.
- Layers company (org profile) > Pi > app (code defaults, then owner config) > session; only narrowing; one sheet per
  scope (`LockSheet`), `LockEditors` registry, agent tools `locks_*` from the owner's sessions.
- Locks take effect from the next turn; no check at the call.
- Plugin switch: non-base plugins (user root) get `plugin:<name>` per app/session; `otherPlugins: "on"|"off"` per
  app; install dialog chooses apps; base filters in its registries (harness, page per pane `{ app, session }`); an
  app's own plugin always on. Company ban = loader admission (kit).
- All user-visible text in p3 is i18n (`MessageData`); Radius gets catalogs in reports.
- Open: candidates (registry of functions vs live state; projects without a worker; pickers per type), the page side of
  the plugin switch, kit/Radius changes.

**Org**
- Org profile = company layer: enrollment file on disk (initial copy), then Radius (signed, cached, live). Radius
  learns locks from Pi reports, or when the admin says "analyse this plugin" (Radius loads its server facets in a
  sandbox and collects its `Locks`). Machine lock-down (service user, signed
  executable, gondolin sandboxes incl. krun, device key) in `org-managed/book.md`.

**Process rules (owner)**
- Read things fully; never present invented APIs; mark code BUILT/PROPOSED; every function shown must be real or
  defined with what it does.
- Never write about competing products in public repos (global AGENTS.md).
- Handoffs start with "Read first, in full" (global AGENTS.md).
- Code mostly committed after review; docs may be committed.

## Also today (built, committed, deployed or pending)
- Offline label fix: `21e4cb80d` (Chord connection loop: canRetry beside the next attempt; p2 Offline after 2 s).
  Deploy to the phone requested from the phone dev session; no confirmation seen yet.
- Mail plugin search (`mail_search`) on the phone (user plugin root, not in git).
- design.md made current with code (827383a15).
- Research notes on other products' team modes are in the repo (owner kept them) and private copies.

## Next
1. Fable's two reviews (admission round 2, locks + candidates) → fold in.
2. Owner decides the three admission points and candidates.
3. Build admission in Chord (builder subagent, reviews, owner approves commit), the wire fence, kit changes
   (sign-in subject resolution if still needed, `revokedBy` for workers, closing links on device removal, pairing for
   persons, loader admission).
4. Then "what it means to create an app" (deferred by the owner).
