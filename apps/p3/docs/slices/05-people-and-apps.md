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

**Also read (docs audit, 2026-11-14; "Chord dec." is `packages/chord/docs/decisions.md` by entry title and line, "archive" is `../archive/`, "research" is `/home/badlogic/chord-notes/research/p3-people-2026-11-13/` on slayer):**

- **research:** `admission-review2-adm-fable.md` B1 (the AppData shape), `admission-review-apps-opus.md` §1 (base
  policy, `sessionAdmission`), `apps-brief.md` (target experience, rejections), `apps-sol.md` and `apps-astra.md`
  (kit gaps).
- **Chord:** `src/host/host.ts:150-160` (`RevokedBy`), `src/host/revocation.ts`, `src/node/http/authenticate.ts`,
  `src/node/app/ephemeral-sign-ins.ts`, `secrets.ts`; design §4 (revocation R10/R11), §23 HTTP (authentication);
  Chord dec. "Sign-ins, not sessions" (3528), "The kit's owner is a principal" (2702), "Revocation without field
  patterns" (154), "The HTTP component's security baseline" (2047).
- **archive:** `people/book.md:419-438` (all six kit changes), `:204-213`, `:251-253`, `:276-281`, `:550-558`;
  `apps/book.md:810-822`; `accounts/book.md` (Identity at :102, Integration at :262); `sharing.md` §1 and owner
  direction; `model-stress/report.md:933-945` (local versus relayed owner); `rundown/book.md:1526-1534`.
- **p2:** `apps/p2/plugins/devices/`, `radius/`, `proxy-marker/`, `login/`.

**Open or to carry (docs audit):**

- Base policy proposals (`research/admission-review-apps-opus.md` §1): the base's `defineFacet` refuses to serve a
  remote type with a `session` param without an admission; a helper `sessionAdmission`; one `SessionAccess` per
  (session, person); one denial reason for "no such session" and "not yours" (no leak of which ids exist).
- Kit facts (`research/apps-sol.md`, `apps-astra.md`, `archive/apps/book.md` 810-822): `SignIns.revoke` does not call
  `host.revoke`; invites are single use, in memory, HTTP only; email delivery is not identity verification; no OAuth
  client helper and no secrets object; a server-local `Revocations.revoke(r)`.
- Decided content in `archive/people/book.md`: the device token file `~/.pi/clients/<pi>.json` (0600, a bearer); OAuth
  directly at Google or GitHub is impractical; `pi join <link>`; `/invite <name> <app>:<role>` in the terminal; what a
  person sees on landing; an app gives persons a slice of another plugin through its own local store.
- The product requirements (`research/apps-brief.md`): the robot, family, club, coding per project, music,
  environments with a caretaker behind approvals; a person using a pane directly is stopped like the agent.
- Sharing and peer audiences as locks (from the withdrawn org entry).
