# Slice 5: people and apps

**Goal.** The owner invites persons; they sign in through an identity provider; apps decide from their own data who
may see or send in their sessions (through admission).

**Builds:** plugin `people` (persons, identities, invites, identity providers: Radius and this device; pairing for
more devices), plugin `apps` (the apps registry, `defaultApp`, coding as the built-in app), `SessionAccess` in
`sessions`, admissions on every session object; the kit changes: `revokedBy` for workers, removing a device closes its
links, pairing for persons (a browser gets its cookie).

**Depends on:** slices 1–4.

**Read first:** `archive/people/book.md` (identity and joining, apps, kit changes, the club example; its principal,
stamps and session check are superseded by admission and the identity-only principal); `decisions.md` (2026-11-13);
the admission design §7; the kit's `sign-ins.ts`, `pairing.ts`, `invite.ts`, `users.ts`; p2's
`plugins/sharing/server.ts`, `store.ts`, `src/runtime/principals.ts` as precedent.

**From the archive:** `archive/sharing.md` (sharing, the owner's direction of 2026-11-10), `archive/apps/book.md` (the superseded per-app user pools: the record), `archive/apps/web-ui-direction.html` (the apps mockup: robot, family, club).
