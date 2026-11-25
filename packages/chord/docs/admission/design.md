# Chord: admission before the factory (design, PROPOSED)

Status: proposed 2026-11-13 by the p3 session, after a first review by Opus, Astra, Sol and Fable 5.2 (their reports:
`/home/badlogic/chord-notes/research/p3-people-2026-11-13/admission-review-*.md`). Not built. It changes design.md §6
(activation), §7 ("there is no async activation guard"), §16 (`serve` options), §19 (presence) and §21 (staging).

## 0. Revision (owner, 2026-11-14): the admission hands the factory its data

The reason for admission is that a factory is synchronous: it cannot read data about the caller before it builds the
caller's object. Returning only a level (a variant name) defeats that: the admission reads the person's app data
(role, team, memberships, shares) and throws it away, and the factory has to read it again after activation. So:

- **`admit` returns `allow(value)` or `deny(reason)`, where `value` is a typed JSON value** the contract declares (an
  `admission` schema beside the variants). The variant is one field of it; the rest is whatever the object needs
  about this caller (for the family app: a parent, their id, the children whose private sessions they may see).
- **The factory gets the value** instead of a level: `(params, principal, admitted, self)`. It builds the caller's
  members from it, including how its lists filter rows, so a list inside an object needs no second mechanism.
- **Change:** a recomputed value equal to the last (canonical JSON) changes nothing; a different one rebinds the
  caller as a level change does in section 3.
- **Not only sessions:** every object type, an app's own stores and objects included, may take an admission. An app
  defines its admission once (in its contract file) and reuses it for all its objects, so every object of the app
  starts from the same answer to "who is this person here".
- Plugins never branch on principal kinds; they read the admitted value.

Still open (owner, 2026-11-14): admission is opt-in per type (a type without one and without a check in its factory
serves everyone); routing runs before admission (a person who will be denied still starts a worker); every object
makes its own round trip for the same answer; a change seals and rebuilds the caller's objects.

## 1. Problem

A factory decides its variant from params and principal only, synchronously (principle 3, §6, §7); what it declares
(`self.get`, keyed pins, registries) has values only after it returned. Access that depends on data therefore has no
place: p3's Tanja has a private chat, session `01jf`; Max, also in her family, opens it. Whether he may see or send
depends on rows in the server's store (the session's app, creator, privacy) and on the family app's own data
(members). The transcript's factory cannot choose `participant`, `viewer` or `forbidden` for him. Every workaround
tried (stamped principals, session lists in the principal with revisions, structured session ids, one variant plus a
check in every method, `self.choose` inside the factory) either moves data into the principal or fights Chord's
activation.

## 2. The change

```ts
host.serve(Type, factory, { admit });            // the existing options object (it has `linger`)

type Admission<L extends string> = { readonly kind: "allow"; readonly level: L } | { readonly kind: "deny"; readonly reason: string };
export const allow = <L extends string>(level: L): Admission<L> => ({ kind: "allow", level });
export const deny = (reason: string): Admission<never> => ({ kind: "deny", reason });

/** Runs first in every attempt of the object. Its `self` declares only references, registries and derives. */
type Admit<C, P, L extends string> = (params: ParamsOf<C>, principal: P, self: AdmitSelf) => Readable<Admission<L>>;
/** With an admission, the factory gets the allowed level as an argument after the principal (fixed for the attempt). */
type AdmittedFactory<C, P, L extends string> = (params: ParamsOf<C>, principal: P, level: L, self: Self<P>) => Implementation<C>;
```

- `AdmitSelf` has `get` (references; a remote object's `self.get` acts as its principal, §4), `registry` and `derive`.
  No natives, documents, tables, live queries, routines, jobs or contributions: the admission decides, it owns nothing.
- The level is a string (the variant name is a natural choice), so "changed" is `!==` and a level fits old and new code.
- Only `remote` contracts take an admission (a `local` object has no principal).

## 3. Semantics

The object keeps its identity (type, params, principal key) and lives across attempts as today; each attempt is
admitted, then built.

1. **Admit.** An attempt of an admitted type runs `admit` first (in `host/attempt.ts #activate`, before `#declare`):
   its requests are bound and the attempt parks on them with the existing parking (`loading`, `failed { waiting }`,
   `readyTimeout` paused, keyed pins loaded, `parked_long`, cycle edges).
2. **Decide.** With every admission request live and hydrated, the decision is read:
   - `deny`: the attempt stays parked and the object shows `failed { kind: "denied", error: forbidden(reason) }`, a
     new failure kind: getters (`host.get`, `ctx.get`) reject at once; held references stay; a dependent that
     declared it stays parked (it does not break: `host/dependencies.ts` treats this kind as healing); a later
     `allow` wakes the attempt like a recovered dependency;
   - `allow(level)`: the factory runs with `level`, the object activates and goes live as today.
3. **Watch.** From the read on, the attempt follows the decision and the health of every admission request (state,
   keyed hydration, the derive's success), checked synchronously before the attempt serves another call or publishes:
   - the same level: nothing happens (an equal recompute never restarts);
   - another level, `deny`, or a request that is no longer live and hydrated (a lost link, a failed registry, a
     derive that throws): the attempt is **sealed at once** (`forbidden/revoked` to calls in flight and queued,
     transactions refused, events stopped; no drain: withdrawn authority stops immediately), its teardown runs in
     the background (natives close, bounded by `closeTimeout`; commits admitted before the seal stay), and a new
     attempt starts and runs `admit` afresh (rapid changes skip intermediate values: one generation counter per
     object; only the newest attempt publishes).
4. **Holders** stay on the object throughout: a change shows them `loading`, then a `bound` with the new variant (the
   existing re-bind path; §7: "a re-hold may bind another variant"); a denial shows `failed { denied }` and drops
   their last values (withdrawn access must not stay readable); an allow afterwards binds them again. A held
   reference never ends because of an admission; `host.revoke` still ends everything for good.
5. **Presence** (`host.references`) lists a holder only while the object's current attempt is admitted.
6. **Linger:** a lingering object without holders whose decision changes ends instead of restarting.

## 4. Wire

No new message or field. Rapid changes (A → B → C before B is acknowledged) need the per-acknowledgement binding
fence in `remote/hold.ts #bindTo` (today it keeps one previous name table, so a call sent with B's indexes can be
decoded by A's): keep one `{ names, until }` per unacknowledged `bound` and decode by the newest acknowledged.

## 5. Reload and staging

- **Staging** runs the new `admit` against the recording `self` (its requests are recorded for readiness and the
  closure rule) and rehearses the new factory with the object's current level; an object without one (parked,
  denied, failed) is not rehearsed. Old and new code must accept the same level strings (a level the new factory
  does not know fails that object's runtime activation, reported).
- **The commit** restarts the object as today: the old attempt (old `admit`, old factory) serves old work until its
  seal; the successor runs the new `admit`, then the new factory. A decision change during the drain seals the old
  attempt at once too.

## 6. What it is not

- Not a route check: a route's `authorize` stays synchronous. A person the admission will deny may still start a
  worker (it gets nothing and the worker idles out).
- Not instantaneous across hosts: a decision computed on the server reaches a worker with the next state message;
  the cut-off is when the serving host sees the change.
- Not a rights framework: who may do what is the app's code, read by admissions.

## 7. Use in p3

The person principal is identity only: `{ kind: "person", id, name }` (and `{ kind: "owner" }`). Roles, shares and
private sessions are data.

```ts
// plugins/sessions (server): the session facts, and the decision a worker asks for
export const SessionsStore = local("sessions.store", { version: 1, params: {}, members: {
	facts: keyed(SessionFacts),                       // absent key: initial() = { kind: "absent" }
} });
export const SessionAccess = remote("sessions.access", { version: 1,
	params: { session: str(), person: str() },        // the person as data: a worker acts as itself upward (§4)
	hostAddress: () => Server(),
	variants: { worker: { state: { admission: AdmissionSchema } } } });

host.serve(SessionAccess, ({ session, person }, principal, self) => {
	if (principal.kind !== "worker" || principal.session !== session) throw forbidden("session workers only");
	const facts = self.get(SessionsStore, {}).facts.at(session);
	const apps = self.registry(Apps);
	return { variant: "worker", members: {
		admission: self.derive([facts, apps], ([f, table]) =>
			f.kind === "absent" ? deny("no access") : (table.get(f.app)?.value.access(person, f) ?? deny("no access"))),
	} };
});
```

```ts
// an app's rule changes with its data: its contribution is a writable the app replaces (registries follow it, §17)
host.serve(FamilyStore, (_params, self) => {
	const all = self.query(self.table(Members), query(Members), 200);
	const entry = self.writable(familyApp(all.value));
	self.on(all, ({ value }) => entry.set(familyApp(value)));
	self.contribute(Apps, entry);
	return {};
});
function familyApp(rows: readonly MemberRow[]): AppContribution {
	const member = (person: string) => rows.some((r) => r.person === person);
	return { id: "family", access: (person, f) =>
		f.private ? (f.creator === person ? allow("write") : deny("no access"))
		: member(person) ? allow("write") : deny("no access") };
}
```

```ts
// any session object on the worker: admitted per person
host.serve(Transcript, ({ session, conversation }, principal, level, self) =>
	level === "write" ? { variant: "participant", members: { /* … */ } } : { variant: "viewer", members: { /* … */ } },
{ admit: ({ session }, principal, self) =>
	principal.kind === "owner" ? constant(allow("write"))
	: principal.kind === "person" ? self.get(SessionAccess, { session, person: principal.id }).admission
	: constant(deny("no access")) });
```

Max opens `01jf`: his transcript attempt asks `SessionAccess { 01jf, max }`, the server answers `deny`, he sees "no
access". Tanja shares it: the family app's entry changes, `Apps` recomposes, the derive answers `allow("read")`, his
attempt wakes, he gets `viewer`. She withdraws it: `deny`, his attempt is sealed, his reference shows `failed
{ denied }`.

## 8. Tests the build must have

Deny → allow through a direct hold and through a dependent's `self.get`; write → read with calls running and queued;
a change while the attempt activates; source loss and recovery (link, registry failure, a throwing derive); a
plugin reload during an admission change; A → B → C before acknowledgements, with a call between; last release while
denied and during linger; two shared references with one released during a re-bind; presence never listing a denied
holder; `host.revoke` of a denied principal.
