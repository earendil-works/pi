// The sessions store (`SessionsStore`): the sessions, their members, the things (records of their kinds, one id each,
// owned by a person, a group, the Pi or nobody), which session uses which thing (links) and the options per link and
// party; their named queries, and every write. Session data is keyed by the session's address (so a session's export,
// import and delete carry it); the things are the Pi's. The writes check what they are given (a trust boundary: the
// owner's and persons' wire input through the plugin's objects, and apps' server code): the app is installed, the
// environment, persons and groups exist, a kind is installed, its input and options pass their schemas. A thing nobody
// owns lives in the sessions that use it and is deleted with its last link; a kind's `create` runs after the commit
// that made its thing (a throw deletes the thing again), its `delete` after the one that removed it.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	and,
	type Bringer,
	type Ctx,
	checkValue,
	defineColumns,
	defineTable,
	eq,
	type FacetHost,
	gt,
	host as hostColumn,
	inArray,
	int,
	invalid,
	type JsonValue,
	json,
	type Location,
	type Member,
	type OptionsFor,
	type P3Principal,
	type Party,
	prefix,
	query,
	type RowOf,
	reportError,
	Session,
	type SessionRow,
	type SessionState,
	type SetOf,
	type StoreSelf,
	str,
	type TableOf,
	THIS_DEVICE,
	type ThingOwner,
	type ThingUse,
	type Tx,
	unknown,
} from "@earendil-works/p3/v1";
import {
	Apps,
	EnvironmentsStore,
	PeopleStore,
	ServerRuntime,
	SessionsStore,
	type ThingKindEntry,
	ThingKinds,
} from "@earendil-works/p3/v1/server";
import { followedOwners } from "./follow.ts";

/**
 * A session's row: its address, app, title, location, when it was made, its state, when it was last touched, and when
 * it was archived. `archivedAt` is 0 while it is not archived: lists need it in their index, and index and order
 * columns are never optional. A column set, so memberships can be joined with their session.
 */
const ROW = {
	id: hostColumn(Session),
	app: str(),
	title: str(),
	environment: str(),
	folder: str(),
	createdAt: int(),
	state: str(),
	lastTouch: int(),
	archivedAt: int(),
	// Whom it follows: `""` nobody, `person:<id>`, `group:<id>`.
	follows: str(),
};

/** The rows' columns as a set (see `ROW`). */
const RowColumns = defineColumns("sessions.row-columns", { columns: ROW, key: ["id"] });

/**
 * Every session, one row each. One index per list: a list's whole order (its column, then the key) must be its
 * index's after the columns its condition fixes, or SQLite sorts every page it reads.
 */
const Rows = defineTable("sessions.rows", {
	version: 1,
	columns: ROW,
	key: ["id"],
	indexes: {
		active: ["app", "archivedAt", "lastTouch"],
		archived: ["app", "archivedAt"],
		working: ["state", "archivedAt"],
	},
	exposes: RowColumns,
});

/** A row of `Rows`. */
type Row = RowOf<typeof ROW>;

/**
 * A session's members: one row per member (`person:<id>`, `group:<id>`), its access and its position in the order
 * they were added. By member for the memberships lists, by position for a session's members.
 */
const Members = defineTable("sessions.members", {
	version: 1,
	columns: { session: hostColumn(Session), member: str(), access: str(), position: int() },
	key: ["session", "member"],
	indexes: { by_member: ["member"], by_position: ["session", "position"] },
});

/** The things' columns: a set, so a session's links can be joined with their thing. */
const ThingColumns = defineColumns("sessions.thing-columns", {
	// `owner`: `none`, `pi`, `person:<id>`, `group:<id>` (`ownerKey`); `everywhere`: 1 "in all my sessions", else 0
	// (an index column, so an int).
	columns: { id: str(), kind: str(), name: str(), owner: str(), createdAt: int(), everywhere: int() },
	key: ["id"],
});

/**
 * Every thing, by id: a record of its kind (its plugin keys the content by the id); by owner and name for owners'
 * lists; "in all my sessions" by owner, for the sessions that follow them; by owner, kind and age for `ensureThing`.
 */
const Things = defineTable("sessions.things", {
	version: 1,
	columns: { ...ThingColumns.columns },
	key: ["id"],
	indexes: {
		by_owner: ["owner", "name"],
		by_everywhere: ["everywhere", "owner"],
		of_kind: ["owner", "kind", "createdAt"],
	},
	exposes: ThingColumns,
});

/**
 * Which session uses which thing: one link per session and thing, who linked it (`app`, `agent`, `person:<id>`)
 * and its position in the order they were linked. By position for a session's things, by thing for the sessions a
 * thing is in.
 */
const Links = defineTable("sessions.links", {
	version: 1,
	columns: { session: hostColumn(Session), thing: str(), by: str(), position: int() },
	key: ["session", "thing"],
	indexes: { by_position: ["session", "position"], by_thing: ["thing"] },
});

/**
 * How many things each session links: a session holds at most `HOLDS`, so every read of its things, read whole, can
 * show them. A table of its own, kept by every write of a link in the same commit: no live read reads it, so a link
 * runs nothing more than its own reads; a session without a row links none.
 */
const LinkCounts = defineTable("sessions.link-counts", {
	version: 1,
	columns: { session: hostColumn(Session), links: int() },
	key: ["session"],
});

/** How many things a session holds (links): a write that would link more is refused before it commits. */
const HOLDS = 1000;

/**
 * The options of a session's things, by whom (`everyone`: the session's default, which every thing has; `agent`;
 * `person:<id>`; `group:<id>`), with the kind's version they were written at. Checked against the kind's schema
 * when written; stored as JSON whatever the kind.
 */
const OPTIONS = {
	session: hostColumn(Session),
	thing: str(),
	for: str(),
	version: int(),
	options: json(unknown(), { version: 1 }),
};

/** The options' table (see `OPTIONS`). */
const Options = defineTable("sessions.options", {
	version: 1,
	columns: OPTIONS,
	key: ["session", "thing", "for"],
	// By thing: a thing deleted takes its options everywhere, also those of sessions that only follow it.
	indexes: { by_thing: ["thing"] },
});

/** Serves `SessionsStore` on `host`. */
export function serveStore(host: FacetHost<P3Principal>): void {
	host.serve(SessionsStore, (_params, self) => {
		const rows = self.table(Rows);
		const members = self.table(Members);
		const things = self.table(Things);
		const links = self.table(Links);
		const options = self.table(Options);
		const counts = self.table(LinkCounts);
		const people = self.get(PeopleStore, {});
		const environments = self.get(EnvironmentsStore, {});
		const apps = self.registry(Apps);
		const kinds = self.registry(ThingKinds);
		const runtime = self.registry(ServerRuntime);
		/** Sets `change` on session `id`'s row: an `update`, so only the reads that depend on those columns run. */
		const update = (id: string, change: SetOf<typeof ROW, readonly ["id"]>, ctx: Ctx<P3Principal>) =>
			self.tx(async (tx) => {
				await mustExist(tx, id);
				tx.update(rows, { id: Session({ id }) }, change);
				return null;
			}, ctx);
		/** Throws unless session `id` exists, as `tx` sees it. */
		const mustExist = async (tx: Tx, id: string) => {
			if ((await tx.get(rows, { id: Session({ id }) })) === undefined) {
				throw invalid("args", `sessions: no session ${id}`);
			}
		};
		/** Thing `id` as `tx` sees it; throws when there is none. */
		const thingIn = async (tx: Tx, id: string) => {
			const found = await tx.get(things, { id });
			if (found === undefined) throw invalid("args", `sessions: no thing ${id}`);
			return found;
		};
		/** Throws unless the person or group `party` exists. */
		const partyMustExist = async (party: Party, ctx: Ctx<P3Principal>) => {
			const found =
				party.kind === "person"
					? await people.persons.one.page({ id: party.id }, 1, ctx)
					: await people.groups.one.page({ id: party.id }, 1, ctx);
			if (found.items.length === 0) throw invalid("args", `sessions: no ${party.kind} ${party.id}`);
		};
		/** Throws unless `owner` exists (a person's or group's row; the Pi and nobody always do). */
		const ownerMustExist = async (owner: ThingOwner, ctx: Ctx<P3Principal>) => {
			if (owner.kind === "person" || owner.kind === "group") await partyMustExist(owner, ctx);
		};
		/** The kind of `name`, which must be installed. */
		const kindOf = (name: string): ThingKindEntry => {
			const entry = kinds.value.get(name)?.value;
			if (entry === undefined) throw invalid("args", `sessions: no kind of thing ${name}`);
			return entry;
		};
		/** `given` options of `entry`'s kind (none: its initial), checked against its schema. */
		const checkedOptions = (entry: ThingKindEntry, given: unknown) => {
			const { kind } = entry;
			const value = (given ?? kind.initial) as JsonValue;
			const failed = checkValue(kind.options, value);
			if (failed !== undefined) throw invalid("args", `sessions: options of ${kind.name}: ${failed}`);
			return { version: kind.version, options: value };
		};
		/** A new thing checked: its kind installed, its owner existing, its input and its options passing their schemas. */
		const checkedNew = async (thing: NewOne, ctx: Ctx<P3Principal>) => {
			const entry = kindOf(thing.kind);
			const owner = thing.owner ?? NOBODY;
			await ownerMustExist(owner, ctx);
			// A trust boundary: the input travels from a page; only a kind that asks for one gets one.
			if (thing.input !== undefined) {
				if (entry.input === undefined) throw invalid("args", `sessions: ${thing.kind} takes no input`);
				const failed = checkValue(entry.input, thing.input);
				if (failed !== undefined) throw invalid("args", `sessions: input of ${thing.kind}: ${failed}`);
			}
			const made = {
				id: crypto.randomUUID(),
				kind: thing.kind,
				name: thing.name ?? "",
				owner,
				everywhere: thing.everywhere ?? false,
			};
			return { entry, made, input: thing.input as JsonValue | undefined, ...checkedOptions(entry, thing.options) };
		};
		/** Writes thing `made` (a new one) and, with a session, its link and default options there. */
		const putNew = async (tx: Tx, made: Made, link: LinkTo | undefined) => {
			const { id, kind, name, owner } = made;
			const everywhere = made.everywhere ? 1 : 0;
			tx.put(things, { id, kind, name, owner: ownerKey(owner), createdAt: Date.now(), everywhere });
			if (link === undefined) return;
			await putLink(tx, link, id);
			putDefault(tx, link.session, id, made.version, made.options);
		};
		/** Writes the link of thing `thing` to `link.session` at `link.position` by `link.by`, counted (`counted`). */
		const putLink = async (tx: Tx, link: LinkTo, thing: string) => {
			await counted(tx, link.session, 1);
			tx.put(links, {
				session: Session({ id: link.session }),
				thing,
				by: bringerKey(link.by),
				position: link.position,
			});
		};
		/** Writes the default options of thing `thing` in session `id`. */
		const putDefault = (tx: Tx, id: string, thing: string, version: number, value: JsonValue) => {
			tx.put(options, { session: Session({ id }), thing, for: "everyone", version, options: value });
		};
		/**
		 * Adds `delta` to session `id`'s count of links; refuses (`invalid`) a count over `HOLDS`. `tx.get` overlays the
		 * transaction's own writes, so several links in one commit count each.
		 */
		const counted = async (tx: Tx, id: string, delta: number) => {
			const session = Session({ id });
			const now = ((await tx.get(counts, { session }))?.links ?? 0) + delta;
			if (now > HOLDS) throw invalid("args", `sessions: a session holds ${HOLDS} things`);
			tx.put(counts, { session, links: now });
		};
		/** Runs each new thing's kind's `create` after the commit; one that throws deletes its thing, then fails. */
		const created = async (made: readonly NewChecked[], ctx: Ctx<P3Principal>) => {
			for (const { entry, made: thing, input } of made) {
				try {
					await entry.create?.({ id: thing.id, name: thing.name, owner: thing.owner }, input, ctx);
				} catch (error) {
					await removeThings(
						made.map(({ made: each }) => each.id),
						ctx,
					);
					throw error;
				}
			}
		};
		/** Deletes things `ids` everywhere in one commit, then their content (each kind's `delete`). */
		const removeThings = async (ids: readonly string[], ctx: Ctx<P3Principal>) => {
			const gone = await self.tx(async (tx) => {
				const dropped: { id: string; kind: string }[] = [];
				for (const id of ids) {
					const found = await tx.get(things, { id });
					if (found !== undefined) dropped.push({ id, kind: await dropThing(tx, id) });
				}
				return dropped;
			}, ctx);
			await contentGone(gone, ctx);
		};
		/** Deletes thing `id` (which exists), its links and their options; answers its kind. */
		const dropThing = async (tx: Tx, id: string): Promise<string> => {
			const found = await thingIn(tx, id);
			// Index `by_thing`: every session that uses it, no cap (a link left over would point at nothing).
			for await (const link of tx.rows(
				links,
				query(Links).where((l) => eq(l.thing, id)),
			)) {
				await dropLink(tx, link.session.params.id, id);
			}
			// Index `by_thing`: the options sessions that follow it set, with no link of theirs.
			for await (const row of tx.rows(
				options,
				query(Options).where((o) => eq(o.thing, id)),
			)) {
				tx.delete(options, { session: row.session, thing: id, for: row.for });
			}
			tx.delete(things, { id });
			return found.kind;
		};
		/** Deletes the link of thing `thing` to session `id` and its options there. */
		const dropLink = async (tx: Tx, id: string, thing: string) => {
			const session = Session({ id });
			await unlink(tx, id, thing);
			// The key's prefix `session`, `thing`: the link's options, every one.
			const of = query(Options).where((o) => and(eq(o.session, session), eq(o.thing, thing)));
			for await (const row of tx.rows(options, of)) tx.delete(options, { session, thing, for: row.for });
		};
		/** Deletes the link of thing `thing` to session `id`, if there is one, counted; its options stay. */
		const unlink = async (tx: Tx, id: string, thing: string) => {
			const session = Session({ id });
			if ((await tx.get(links, { session, thing })) === undefined) return;
			await counted(tx, id, -1);
			tx.delete(links, { session, thing });
		};
		/** Each gone thing's content, dropped by its kind's `delete`; a failure is reported (the thing is gone). */
		const contentGone = async (gone: readonly { id: string; kind: string }[], ctx: Ctx<P3Principal>) => {
			for (const { id, kind } of gone) {
				try {
					await kinds.value.get(kind)?.value.delete?.(id, ctx);
				} catch (error) {
					reportError(`p3 sessions: ${kind}'s delete of ${id}`, error, ctx);
				}
			}
		};
		/** The position after session `id`'s last member (index `by_position`). */
		const nextMember = async (tx: Tx, id: string) => {
			const order = query(Members)
				.where((m) => eq(m.session, Session({ id })))
				.orderBy((m) => m.position, "desc");
			return after((await tx.page(members, order, 1)).items[0]);
		};
		/** The position after session `id`'s last link (index `by_position`). */
		const nextLink = async (tx: Tx, id: string) => {
			const order = query(Links)
				.where((l) => eq(l.session, Session({ id })))
				.orderBy((l) => l.position, "desc");
			return after((await tx.page(links, order, 1)).items[0]);
		};
		/** Throws unless `location`'s environment exists. */
		const environmentMustExist = async (location: Location, ctx: Ctx<P3Principal>) => {
			const found = await environments.environments.one.page({ id: location.environment }, 1, ctx);
			if (found.items.length === 0) throw invalid("args", `sessions: no environment ${location.environment}`);
		};
		/**
		 * Deletes member `member` of session `id`, the options set for it, and the links of the things it owns (a
		 * person's, a group's); the session's content stays.
		 */
		const deleteMember = async (tx: Tx, id: string, member: string) => {
			const session = Session({ id });
			tx.delete(members, { session, member });
			await deleteOptions(tx, id, (row) => row.for === member);
			// The key's prefix `session`: the session's links, read whole (each one's thing is asked its owner).
			for await (const link of tx.rows(
				links,
				query(Links).where((l) => eq(l.session, session)),
			)) {
				if ((await tx.get(things, { id: link.thing }))?.owner === member) await dropLink(tx, id, link.thing);
			}
		};
		/** Deletes session `id`'s options that `matches` keeps, each by its key (readers of other rows skip). */
		const deleteOptions = async (tx: Tx, id: string, matches: (row: RowOf<typeof OPTIONS>) => boolean) => {
			const session = Session({ id });
			// The key's prefix `session`: a session's options, read whole (each one is deleted or kept).
			for await (const row of tx.rows(
				options,
				query(Options).where((o) => eq(o.session, session)),
			)) {
				if (matches(row)) tx.delete(options, { session, thing: row.thing, for: row.for });
			}
		};
		/** The thing of `use` checked: a new one (`checkedNew`), or an existing one (its kind's options checked). */
		const checkedUse = async (use: ThingUse, ctx: Ctx<P3Principal>): Promise<UseChecked> => {
			if (use.use === "new") return { use: "new", ...(await checkedNew(use, ctx)) };
			const found = await self.tx(async (tx) => thingIn(tx, use.thing), ctx);
			return { use: "existing", thing: use.thing, ...checkedOptions(kindOf(found.kind), use.options) };
		};
		/**
		 * The things session `id` has from whom it follows now (linked or not), as `follow`'s keep links them: the
		 * followed party's "in all my sessions" things while it writes in the session (`followedOwners`).
		 */
		const followedNow = async (id: string, ctx: Ctx<P3Principal>) => {
			const row = await self.tx((tx) => tx.get(rows, { id: Session({ id }) }), ctx);
			if (row === undefined || row.follows === "") return [];
			const party = partyOf(row.follows);
			const person = party.kind === "person" ? party.id : "";
			const [who] = (await people.persons.one.page({ id: person }, 1, ctx)).items;
			const theirs = await people.groups.ofPerson.page({ person }, FOLLOW_READ, ctx);
			// Their groups count only when read whole (fails closed).
			const groups = theirs.next === undefined ? theirs.items.map(({ id: group }) => group) : [];
			const session = Session({ id });
			return self.tx(async (tx) => {
				const all: Member[] = [];
				for await (const m of tx.rows(
					members,
					query(Members).where((m) => eq(m.session, session)),
				)) {
					all.push({ ...partyOf(m.member), access: m.access as Member["access"] });
				}
				const owners = followedOwners(party, {
					archived: row.archivedAt !== 0,
					isOwner: who?.owner === true,
					groups,
					members: all,
				});
				// Index `by_everywhere`: `everywhere` fixed, each of `owners`, in the order of owner.
				const of = query(Things)
					.where((t) => and(eq(t.everywhere, 1), inArray(t.owner, owners)))
					.orderBy((t) => t.owner, "asc");
				const found: { id: string }[] = [];
				for await (const thing of tx.rows(things, of)) found.push({ id: thing.id });
				return found;
			}, ctx);
		};
		return {
			...namedQueries(self, { rows, members, things, links, options }),
			create: async ({ app, title, location, members: given, things: used, by, follows }, ctx) => {
				if (!apps.value.has(app)) throw invalid("args", `sessions: no app ${app}`);
				const id = crypto.randomUUID();
				const where = location ?? { environment: THIS_DEVICE, folder: join(runtime.value.dataDir, "folders", id) };
				if (location !== undefined) await environmentMustExist(location, ctx);
				const parties = new Map<string, Member>();
				for (const member of given ?? []) {
					await partyMustExist(member, ctx);
					parties.set(keyOf(member), member);
				}
				const checked: UseChecked[] = [];
				for (const use of used ?? []) checked.push(await checkedUse(use, ctx));
				if (follows !== undefined && follows !== null) await partyMustExist(follows, ctx);
				// An empty folder a failed commit leaves is harmless; a session without its folder is not.
				if (location === undefined) await mkdir(where.folder, { recursive: true, mode: 0o700 });
				const now = Date.now();
				const state: SessionState = "settled";
				await self.tx(async (tx) => {
					const session = Session({ id });
					const { environment, folder } = where;
					tx.put(rows, {
						id: session,
						app,
						title: title ?? "",
						environment,
						folder,
						createdAt: now,
						state,
						lastTouch: now,
						archivedAt: 0,
						follows: followsKey(follows ?? null),
					});
					let position = 0;
					for (const [member, { access }] of parties)
						tx.put(members, { session, member, access, position: position++ });
					for (const [at, use] of checked.entries()) {
						const link = { session: id, position: at, by };
						if (use.use === "new") {
							await putNew(tx, { ...use.made, version: use.version, options: use.options }, link);
						} else {
							await thingIn(tx, use.thing);
							await putLink(tx, link, use.thing);
							putDefault(tx, id, use.thing, use.version, use.options);
						}
					}
					return null;
				}, ctx);
				await created(
					checked.flatMap((use) => (use.use === "new" ? [use] : [])),
					ctx,
				);
				return id;
			},
			rename: ({ session, title }, ctx) => update(session, { title }, ctx),
			archive: ({ session }, ctx) => update(session, { archivedAt: Date.now() }, ctx),
			restore: ({ session }, ctx) => update(session, { archivedAt: 0 }, ctx),
			addMember: async ({ session, member }, ctx) => {
				await partyMustExist(member, ctx);
				return self.tx(async (tx) => {
					await mustExist(tx, session);
					const key = { session: Session({ id: session }), member: keyOf(member) };
					const found = await tx.get(members, key);
					if (found !== undefined) tx.update(members, key, { access: member.access });
					else tx.put(members, { ...key, access: member.access, position: await nextMember(tx, session) });
					return null;
				}, ctx);
			},
			removeMember: ({ session, party }, ctx) =>
				self.tx(async (tx) => {
					await deleteMember(tx, session, keyOf(party));
					return null;
				}, ctx),
			removePerson: async ({ person }, ctx) => {
				const member = `person:${person}`;
				const gone = await self.tx(async (tx) => {
					// Index `by_member`: every session they are in, no cap (a membership left over would grant access).
					for await (const row of tx.rows(
						members,
						query(Members).where((m) => eq(m.member, member)),
					)) {
						const session = row.session;
						tx.delete(members, { session, member });
						await deleteOptions(tx, session.params.id, (option) => option.for === member);
					}
					// Index `by_owner`, in its order (owner, name): every thing they own, no cap, gone with them (their
					// groups' stay).
					const dropped: { id: string; kind: string }[] = [];
					const owned = query(Things)
						.where((t) => eq(t.owner, member))
						.orderBy((t) => t.name, "asc");
					for await (const row of tx.rows(things, owned)) {
						dropped.push({ id: row.id, kind: await dropThing(tx, row.id) });
					}
					return dropped;
				}, ctx);
				await contentGone(gone, ctx);
				return null;
			},
			createThing: async ({ session, by, everywhere, ...thing }, ctx) => {
				if (session === undefined && thing.owner.kind === "none") {
					throw invalid("args", "sessions: a thing nobody owns is made only into a session");
				}
				// "In all my sessions" by default for an owned thing made outside a session; never for one made into one.
				const all = everywhere ?? (session === undefined && thing.owner.kind !== "none");
				const checked = await checkedNew({ ...thing, everywhere: all }, ctx);
				await self.tx(async (tx) => {
					if (session !== undefined) await mustExist(tx, session);
					const link = session === undefined ? undefined : { session, by, position: await nextLink(tx, session) };
					await putNew(tx, { ...checked.made, version: checked.version, options: checked.options }, link);
					return null;
				}, ctx);
				await created([checked], ctx);
				return checked.made.id;
			},
			addThing: async ({ session, thing, by, options: given }, ctx) => {
				await self.tx(async (tx) => {
					await mustExist(tx, session);
					const found = await thingIn(tx, thing);
					if ((await tx.get(links, { session: Session({ id: session }), thing })) !== undefined) {
						throw invalid("args", `sessions: session ${session} has thing ${thing} already`);
					}
					await putLink(tx, { session, by, position: await nextLink(tx, session) }, thing);
					// Without options, those already set here (while it was followed) stay; else the given or the defaults.
					const set = await tx.get(options, { session: Session({ id: session }), thing, for: "everyone" });
					if (given === undefined && set !== undefined) return null;
					const { version, options: value } = checkedOptions(kindOf(found.kind), given);
					putDefault(tx, session, thing, version, value);
					return null;
				}, ctx);
				return null;
			},
			removeThing: async ({ session, thing }, ctx) => {
				// A thing the session also has from whom it follows keeps its options here: it stays, unlinked.
				const followed = (await followedNow(session, ctx)).some(({ id }) => id === thing);
				const gone = await self.tx(async (tx) => {
					const found = await thingIn(tx, thing);
					if (followed) await unlink(tx, session, thing);
					else await dropLink(tx, session, thing);
					if (found.owner !== ownerKey(NOBODY)) return [];
					// Index `by_thing`: is another session using it? Two rows tell (this link is still committed).
					const using = await tx.page(
						links,
						query(Links).where((l) => eq(l.thing, thing)),
						2,
					);
					if (using.items.some((link) => link.session.params.id !== session)) return [];
					return [{ id: thing, kind: await dropThing(tx, thing) }];
				}, ctx);
				await contentGone(gone, ctx);
				return null;
			},
			ensureThing: async ({ kind, owner, name, everywhere }, ctx) => {
				const key = ownerKey(owner);
				const checked = await checkedNew({ kind, owner, name, everywhere: everywhere ?? true }, ctx);
				const made = await self.tx(async (tx) => {
					// Index `of_kind`: the first of that kind and owner, if there is one.
					const first = query(Things)
						.where((t) => and(eq(t.owner, key), eq(t.kind, kind)))
						.orderBy((t) => t.createdAt, "asc");
					const [found] = (await tx.page(things, first, 1)).items;
					if (found !== undefined) return { id: found.id, made: false };
					await putNew(tx, { ...checked.made, version: checked.version, options: checked.options }, undefined);
					return { id: checked.made.id, made: true };
				}, ctx);
				if (made.made) await created([checked], ctx);
				return made.id;
			},
			setEverywhere: ({ thing, everywhere }, ctx) =>
				self.tx(async (tx) => {
					await thingIn(tx, thing);
					tx.update(things, { id: thing }, { everywhere: everywhere ? 1 : 0 });
					return null;
				}, ctx),
			follow: async ({ session, follows, keep = true, by }, ctx) => {
				if (follows !== null) await partyMustExist(follows, ctx);
				const followed = keep ? await followedNow(session, ctx) : [];
				return self.tx(async (tx) => {
					await mustExist(tx, session);
					// What it had from whom it followed, linked by `by` (the app when left out): with the options set for
					// it here while followed, else the defaults.
					const key = Session({ id: session });
					let position = await nextLink(tx, session);
					for (const thing of followed) {
						if ((await tx.get(links, { session: key, thing: thing.id })) !== undefined) continue;
						const found = await tx.get(things, { id: thing.id });
						if (found === undefined) continue;
						await putLink(tx, { session, by, position: position++ }, thing.id);
						if ((await tx.get(options, { session: key, thing: thing.id, for: "everyone" })) !== undefined)
							continue;
						const { version, options: value } = checkedOptions(kindOf(found.kind), undefined);
						putDefault(tx, session, thing.id, version, value);
					}
					tx.update(rows, { id: Session({ id: session }) }, { follows: followsKey(follows) });
					return null;
				}, ctx);
			},
			keepThing: async ({ thing, owner }, ctx) => {
				await ownerMustExist(owner, ctx);
				return self.tx(async (tx) => {
					const found = await thingIn(tx, thing);
					// Kept from content: not "in all my sessions" until its owner says so; an owned thing given on keeps
					// its switch.
					const kept = found.owner === ownerKey(NOBODY) ? { everywhere: 0 } : {};
					tx.update(things, { id: thing }, { owner: ownerKey(owner), ...kept });
					return null;
				}, ctx);
			},
			renameThing: ({ thing, name }, ctx) =>
				self.tx(async (tx) => {
					await thingIn(tx, thing);
					// An update of its name only: the reads that show no name skip.
					tx.update(things, { id: thing }, { name });
					return null;
				}, ctx),
			deleteThing: async ({ thing }, ctx) => {
				const gone = await self.tx(async (tx) => [{ id: thing, kind: await dropThing(tx, thing) }], ctx);
				await contentGone(gone, ctx);
				return null;
			},
			setOptions: ({ session, thing, for: by, options: given }, ctx) =>
				self.tx(async (tx) => {
					const address = Session({ id: session });
					// Linked here or from whom the session follows (callers check which): options are per session,
					// thing and party, with or without a link.
					await mustExist(tx, session);
					const entry = kindOf((await thingIn(tx, thing)).kind);
					const key = { session: address, thing, for: forKey(by) };
					if (by.kind === "person" || by.kind === "group") {
						const member = await tx.get(members, { session: address, member: key.for });
						if (member === undefined) throw invalid("args", `sessions: ${key.for} is no member of ${session}`);
					}
					if (given === null && by.kind !== "everyone") {
						tx.delete(options, key);
						return null;
					}
					// `null` for everyone: the kind's initial again.
					tx.put(options, { ...key, ...checkedOptions(entry, given) });
					return null;
				}, ctx),
			report: ({ session, state }, ctx) => update(session, { state, lastTouch: Date.now() }, ctx),
			working: (_args, ctx) =>
				self.tx(async (tx) => {
					// Index `working`; every row, no cap: a session left out would never resume.
					const ids: string[] = [];
					for await (const row of tx.rows(
						rows,
						query(Rows).where((s) => and(eq(s.state, "working"), eq(s.archivedAt, 0))),
					)) {
						ids.push(row.id.params.id);
					}
					return ids;
				}, ctx),
		};
	});
}

/** How many of a followed person's groups `follow`'s keep reads: more fail closed (their groups count for nothing). */
const FOLLOW_READ = 1000;

/** Nobody: the owner of a session's content. */
const NOBODY: ThingOwner = { kind: "none" };

/** A new thing as a create takes it. */
type NewOne = {
	readonly kind: string;
	readonly name?: string;
	readonly owner?: ThingOwner;
	readonly input?: unknown;
	readonly options?: unknown;
	readonly everywhere?: boolean;
};

/** A new thing as made: its id, kind, name, owner and whether it is "in all my sessions". */
type MadeThing = {
	readonly id: string;
	readonly kind: string;
	readonly name: string;
	readonly owner: ThingOwner;
	readonly everywhere: boolean;
};

/** A new thing with its default options, as written. */
type Made = MadeThing & { readonly version: number; readonly options: JsonValue };

/** A new thing checked: its kind's entry, the thing, its input and default options. */
type NewChecked = {
	readonly entry: ThingKindEntry;
	readonly made: MadeThing;
	readonly input: JsonValue | undefined;
	readonly version: number;
	readonly options: JsonValue;
};

/** A thing a session gets, checked. */
type UseChecked =
	| ({ readonly use: "new" } & NewChecked)
	| { readonly use: "existing"; readonly thing: string; readonly version: number; readonly options: JsonValue };

/** Where a link goes: its session, its position there, and who made it. */
type LinkTo = { readonly session: string; readonly position: number; readonly by: Bringer | undefined };

/** The store's named queries over its tables `rows`, `members` and `options` (see each one's comment for its index). */
function namedQueries(
	self: StoreSelf<P3Principal>,
	{
		rows,
		members,
		things,
		links,
		options,
	}: {
		readonly rows: TableOf<typeof Rows>;
		readonly members: TableOf<typeof Members>;
		readonly things: TableOf<typeof Things>;
		readonly links: TableOf<typeof Links>;
		readonly options: TableOf<typeof Options>;
	},
) {
	return {
		sessions: self.queries(
			rows,
			{ map: shown },
			{
				// Index `active`: `app` and `archivedAt` fixed, in the order of `lastTouch`, then the key.
				active: ({ app }: { app: string }) =>
					query(Rows)
						.where((s) => and(eq(s.app, app), eq(s.archivedAt, 0)))
						.orderBy((s) => s.lastTouch, "desc"),
				// Index `archived`: `app` fixed, a range of `archivedAt` in its order, then the key.
				archived: ({ app }: { app: string }) =>
					query(Rows)
						.where((s) => and(eq(s.app, app), gt(s.archivedAt, 0)))
						.orderBy((s) => s.archivedAt, "desc"),
				// The key.
				one: ({ id }: { id: string }) => query(Rows).where((s) => eq(s.id, Session({ id }))),
			},
		),
		// Two tables serve the members' queries: a session's own, and the memberships, joined with their sessions.
		members: self.queries(
			members,
			{ map: ({ member, access }) => ({ ...partyOf(member), access: access as Member["access"] }) },
			{
				// Index `by_position`: `session` fixed, in the order of `position`.
				of: ({ session }: { session: string }) =>
					query(Members)
						.where((m) => eq(m.session, Session({ id: session })))
						.orderBy((m) => m.position, "asc"),
			},
		),
		memberships: self.queries(
			members,
			{
				// The partner's columns are the row's (a set of them), its address the membership's own.
				map: ({ session }, row) => shown({ ...(row as Row), id: session }),
				reads: ["session"],
				partnerReads: [
					"app",
					"title",
					"environment",
					"folder",
					"createdAt",
					"state",
					"lastTouch",
					"archivedAt",
					"follows",
				],
			},
			{
				// Index `by_member`: each of `members`, joined with its session by the session's key. Ordered by the
				// session's `lastTouch`, a column of the partner: SQLite sorts the memberships (one row per
				// membership: a person's and their groups'). A session they are in twice shows twice.
				active: ({ app, members: of }: { app: string; members: string[] }) =>
					query(Members)
						.where((m) => inArray(m.member, of))
						.join(RowColumns, (m) => ({ id: m.session }))
						.where((_m, s) => and(eq(s.app, app), eq(s.archivedAt, 0)))
						.orderBy((_m, s) => s.lastTouch, "desc"),
				// As `active`, ordered by the session's `archivedAt` (sorted).
				archived: ({ app, members: of }: { app: string; members: string[] }) =>
					query(Members)
						.where((m) => inArray(m.member, of))
						.join(RowColumns, (m) => ({ id: m.session }))
						.where((_m, s) => and(eq(s.app, app), gt(s.archivedAt, 0)))
						.orderBy((_m, s) => s.archivedAt, "desc"),
			},
		),
		things: self.queries(
			things,
			{
				map: ({ id, kind, name, owner, createdAt, everywhere }) => ({
					id,
					kind,
					name,
					owner: ownerOf(owner),
					createdAt,
					everywhere: everywhere === 1,
				}),
			},
			{
				// The key.
				one: ({ id }: { id: string }) => query(Things).where((t) => eq(t.id, id)),
				// Index `by_owner`: each of `owners`, `name` from `prefix` on, in the order of owner, then name.
				owned: ({ owners, prefix: start }: { owners: string[]; prefix: string }) =>
					query(Things)
						.where((t) => and(inArray(t.owner, owners), prefix(t.name, start)))
						.orderBy((t) => t.owner, "asc")
						.orderBy((t) => t.name, "asc"),
				// Index `by_everywhere`: `everywhere` fixed, each of `owners`, in the order of owner, then the key.
				everywhere: ({ owners }: { owners: string[] }) =>
					query(Things)
						.where((t) => and(eq(t.everywhere, 1), inArray(t.owner, owners)))
						.orderBy((t) => t.owner, "asc"),
				// Index `of_kind`: `owner` and `kind` fixed, in the order of `createdAt`, then the key.
				ofKind: ({ owner, kind }: { owner: string; kind: string }) =>
					query(Things)
						.where((t) => and(eq(t.owner, owner), eq(t.kind, kind)))
						.orderBy((t) => t.createdAt, "asc"),
			},
		),
		// The links, each joined with its thing by the thing's key.
		links: self.queries(
			links,
			{
				map: (row, thing) => ({
					session: row.session.params.id,
					thing: row.thing,
					kind: thing.kind as string,
					name: thing.name as string,
					owner: ownerOf(thing.owner as string),
					by: bringerOf(row.by),
				}),
				reads: ["session", "thing", "by"],
				partnerReads: ["kind", "name", "owner"],
			},
			{
				// Index `by_position`: `session` fixed, in the order of `position`.
				of: ({ session }: { session: string }) =>
					query(Links)
						.where((l) => eq(l.session, Session({ id: session })))
						.join(ThingColumns, (l) => ({ id: l.thing }))
						.orderBy((l) => l.position, "asc"),
				// The key.
				one: ({ session, thing }: { session: string; thing: string }) =>
					query(Links)
						.where((l) => and(eq(l.session, Session({ id: session })), eq(l.thing, thing)))
						.join(ThingColumns, (l) => ({ id: l.thing })),
				// Index `by_thing`: `thing` fixed, in the order of the key's rest (the session).
				ofThing: ({ thing }: { thing: string }) =>
					query(Links)
						.where((l) => eq(l.thing, thing))
						.join(ThingColumns, (l) => ({ id: l.thing })),
			},
		),
		options: self.queries(
			options,
			{
				map: (row) => ({
					thing: row.thing,
					for: row.for,
					version: row.version,
					options: row.options as JsonValue,
				}),
			},
			{
				// The key's prefix `session`, `thing`, in the order of `for`.
				of: ({ session, thing }: { session: string; thing: string }) =>
					query(Options).where((o) => and(eq(o.session, Session({ id: session })), eq(o.thing, thing))),
				// The key's prefix `session`, `for` filtered, in the order of `thing`.
				ofSession: ({ session, for: by }: { session: string; for: string }) =>
					query(Options).where((o) => and(eq(o.session, Session({ id: session })), eq(o.for, by))),
				// The key's prefix `session`, in the key's order (`thing`, then `for`).
				inSession: ({ session }: { session: string }) =>
					query(Options).where((o) => eq(o.session, Session({ id: session }))),
			},
		),
	};
}

/** A table row as lists and a session's worker see it. */
function shown({ id, environment, folder, state, archivedAt, follows, ...row }: Row): SessionRow {
	// `state` holds only what this plugin wrote: a `SessionState`.
	return {
		id: id.params.id,
		...row,
		location: { environment, folder },
		state: state as SessionState,
		archivedAt: archivedAt === 0 ? null : archivedAt,
		follows: follows === "" ? null : partyOf(follows),
	};
}

/** Whom a session follows, in the tables: `""` nobody, `person:<id>`, `group:<id>`. */
function followsKey(follows: Party | null): string {
	return follows === null ? "" : keyOf(follows);
}

/** The position after `last` (none: the first). */
function after(last: { readonly position: number } | undefined): number {
	return last === undefined ? 0 : last.position + 1;
}

/** A member's key in the tables: `person:<id>` or `group:<id>`. */
export function keyOf(party: Party): string {
	return `${party.kind}:${party.id}`;
}

/** The person or group of a member's key (written by `keyOf`). */
function partyOf(key: string): Party {
	const colon = key.indexOf(":");
	return { kind: key.slice(0, colon) as Party["kind"], id: key.slice(colon + 1) };
}

/** Who linked a thing, in the tables: `person:<id>`, `agent`, or `app` (also when nobody is named: apps' server code). */
function bringerKey(by: Bringer | undefined): string {
	return by === undefined ? "app" : by.kind === "person" ? `person:${by.id}` : by.kind;
}

/** Who linked a thing, of its key in the tables (written by `bringerKey`). */
function bringerOf(key: string): Bringer {
	return key === "app" || key === "agent" ? { kind: key } : { kind: "person", id: key.slice("person:".length) };
}

/** Whom a thing belongs to, in the tables: `none`, `pi`, `person:<id>`, `group:<id>`. */
export function ownerKey(owner: ThingOwner): string {
	return owner.kind === "none" || owner.kind === "pi" ? owner.kind : keyOf(owner);
}

/** Whom a thing belongs to, of its key in the tables (written by `ownerKey`). */
function ownerOf(key: string): ThingOwner {
	return key === "none" || key === "pi" ? { kind: key } : partyOf(key);
}

/** Whose options in the tables: `everyone`, `agent`, `person:<id>`, `group:<id>`. */
function forKey(by: OptionsFor): string {
	return by.kind === "everyone" || by.kind === "agent" ? by.kind : keyOf(by);
}

/** Whose options, of their key in the tables (written by `forKey`). */
export function optionsForOf(key: string): OptionsFor {
	return key === "everyone" || key === "agent" ? { kind: key } : partyOf(key);
}
