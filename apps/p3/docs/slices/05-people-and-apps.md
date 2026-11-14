# Slice 5: people and apps

**Goal.** The owner invites persons; they sign in through an identity provider; apps decide from their own data who
may see or send in their sessions (through admission).

**Builds:** plugin `people` (persons, identities, invites, identity providers: Radius and this device; pairing for
more devices), plugin `apps` (the apps registry, `defaultApp`, coding as the built-in app), `SessionAccess` in
`sessions`, admissions on every session object. Kit changes (`archive/people/book.md`, What the Kit Must Add):
`revokedBy` on the kit's server and workers (the kit passes none today), removing a device closes its links, pairing
for persons (a browser gets its cookie), no stale admission, authentication precedence (the kit asks authenticators in
plugin-name order).

**Depends on:** slices 1–4.

**Read first, in full:** `decisions.md` (2026-11-13 entries); the admission design §7 and Fable's round 2 B1 (on
slayer: `/home/badlogic/chord-notes/research/p3-people-2026-11-13/admission-review2-adm-fable.md`; it replaces the
design's `FamilyStore` example: the rule is contributed by the facet, its data as a JSON derive); the kit's
`sign-ins.ts`, `pairing.ts`, `invite.ts`, `users.ts`, `owner.ts`, `ephemeral-sign-ins.ts`,
`src/node/http/authenticate.ts`, `http.ts`, `src/host/revocation.ts`; p2's `plugins/sharing/server.ts`, `store.ts`,
`src/runtime/principals.ts`, `plugins/radius/`, `plugins/devices/` as precedent;
`/home/badlogic/chord-notes/research/p3-people-2026-11-13/apps-brief.md` (the target experience). From the archive:
`people/book.md` (identity and joining, apps, kit changes, the club example; its principal, stamps and session check
are superseded), `sharing.md` (modes, expiry, approvals never a person's: never decided), `apps/book.md` (the
superseded per-app pools: the record), `apps/web-ui-direction.html` (the apps mockup).

**Open:**

- `name` in the principal: the kit's sign-ins store the whole principal, so a renamed person keeps the old name in
  every sign-in. Drop `name` from the principal, or resolve the principal at each use (people/book.md kit change 1).
- Where single-session shares and a session's private flag live (the admission design reads `f.private`).
- Slots of switched-on third-party plugins in reused views; the page composing panes, slots and commands per session
  (`people/book.md`, Open Questions).
- What it means to create an app (deferred by the owner, 2026-11-13).
