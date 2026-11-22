// The sessions store (`SessionsStore`): four tables keyed by the session's address (so a session's export, import and
// delete carry them), their named queries, and every write. `create`, `addMember`, `addThing` and `setOptions` check
// what they are given (a trust boundary: the owner's wire input through `Sessions`, and apps' server code): the app is
// installed, the environment, persons and groups exist, a thing's kind is installed and its options pass its schema.
// Each thing says who brought it (`by`: the owner, an app, a person): a member removed, or a person leaving the Pi,
// takes the things they brought along.

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
	type NewThing,
	type OptionsFor,
	type P3Principal,
	type Party,
	query,
	type RowOf,
	Session,
	type SessionRow,
	type SessionState,
	type SetOf,
	type Static,
	type StoreSelf,
	str,
	type TableOf,
	THIS_DEVICE,
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

/** A session's things' columns: a set, so a thing's options can be joined with their thing. */
const ThingColumns = defineColumns("sessions.thing-columns", {
	columns: { session: hostColumn(Session), thing: str(), kind: str(), ref: str(), by: str(), position: int() },
	key: ["session", "thing"],
});

/**
 * A session's things: its id in the session, its kind, its record, who brought it (`owner`, `app`, `person:<id>`)
 * and its position in the order they were added. By position for a session's things, by bringer for a person who
 * leaves the Pi.
 */
const Things = defineTable("sessions.things", {
	version: 1,
	columns: { ...ThingColumns.columns },
	key: ["session", "thing"],
	indexes: { by_position: ["session", "position"], by_bringer: ["by"] },
	exposes: ThingColumns,
});

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
});

/** Serves `SessionsStore` on `host`. */
export function serveStore(host: FacetHost<P3Principal>): void {
	host.serve(SessionsStore, (_params, self) => {
		const rows = self.table(Rows);
		const members = self.table(Members);
		const things = self.table(Things);
		const options = self.table(Options);
		const people = self.get(PeopleStore, {});
		const environments = self.get(EnvironmentsStore, {});
		const apps = self.registry(Apps);
		const kinds = self.registry(ThingKinds);
		const runtime = self.registry(ServerRuntime);
		/** Sets `change` on session `id`'s row: an `update`, so only the reads that depend on those columns run. */
		const update = (id: string, change: SetOf<typeof ROW, readonly ["id"]>, ctx: Ctx) =>
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
		/** Throws unless the person or group `party` exists. */
		const partyMustExist = async (party: Party, ctx: Ctx) => {
			const found =
				party.kind === "person"
					? await people.persons.one.page({ id: party.id }, 1, ctx)
					: await people.groups.one.page({ id: party.id }, 1, ctx);
			if (found.items.length === 0) throw invalid("args", `sessions: no ${party.kind} ${party.id}`);
		};
		/** The kind of `name`, which must be installed. */
		const kindOf = (name: string): ThingKindEntry => {
			const entry = kinds.value.get(name)?.value;
			if (entry === undefined) throw invalid("args", `sessions: no kind of thing ${name}`);
			return entry;
		};
		/** `thing` checked: its kind installed, its options (the kind's initial when it has none) passing its schema. */
		const checkedThing = (thing: Static<typeof NewThing>) => {
			const { kind } = kindOf(thing.kind);
			const given = thing.options ?? kind.initial;
			const failed = checkValue(kind.options, given);
			if (failed !== undefined) throw invalid("args", `sessions: options of ${kind.name}: ${failed}`);
			return { kind: kind.name, ref: thing.ref ?? "", version: kind.version, options: given };
		};
		/** Writes thing `thing` of session `id`, brought by `by`, at `position` with its default options. */
		const putThing = (
			tx: Tx,
			id: string,
			thing: string,
			position: number,
			by: Bringer | undefined,
			checked: ReturnType<typeof checkedThing>,
		) => {
			const session = Session({ id });
			tx.put(things, { session, thing, kind: checked.kind, ref: checked.ref, by: bringerKey(by), position });
			tx.put(options, { session, thing, for: "everyone", version: checked.version, options: checked.options });
		};
		/** The position after session `id`'s last member (index `by_position`). */
		const nextMember = async (tx: Tx, id: string) => {
			const order = query(Members)
				.where((m) => eq(m.session, Session({ id })))
				.orderBy((m) => m.position, "desc");
			return after((await tx.page(members, order, 1)).items[0]);
		};
		/** The position after session `id`'s last thing (index `by_position`). */
		const nextThing = async (tx: Tx, id: string) => {
			const order = query(Things)
				.where((t) => eq(t.session, Session({ id })))
				.orderBy((t) => t.position, "desc");
			return after((await tx.page(things, order, 1)).items[0]);
		};
		/** Throws unless `location`'s environment exists. */
		const environmentMustExist = async (location: Location, ctx: Ctx) => {
			const found = await environments.environments.one.page({ id: location.environment }, 1, ctx);
			if (found.items.length === 0) throw invalid("args", `sessions: no environment ${location.environment}`);
		};
		/** Deletes thing `thing` of session `id` and its options, each by its key. */
		const deleteThing = async (tx: Tx, id: string, thing: string) => {
			const session = Session({ id });
			tx.delete(things, { session, thing });
			// The key's prefix `session`, `thing`: the thing's options, every one.
			const of = query(Options).where((o) => and(eq(o.session, session), eq(o.thing, thing)));
			for await (const row of tx.rows(options, of)) tx.delete(options, { session, thing, for: row.for });
		};
		/** Deletes member `member` of session `id`, the options set for it, and the things it brought. */
		const deleteMember = async (tx: Tx, id: string, member: string) => {
			const session = Session({ id });
			tx.delete(members, { session, member });
			await deleteOptions(tx, id, (row) => row.for === member);
			// The key's prefix `session`, `by` filtered: a group brings nothing, a person their own.
			const brought = query(Things).where((t) => and(eq(t.session, session), eq(t.by, member)));
			for await (const row of tx.rows(things, brought)) await deleteThing(tx, id, row.thing);
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
		return {
			...namedQueries(self, { rows, members, options }),
			create: async ({ app, title, location, members: given, things: added, by }, ctx) => {
				if (!apps.value.has(app)) throw invalid("args", `sessions: no app ${app}`);
				const id = crypto.randomUUID();
				const where = location ?? { environment: THIS_DEVICE, folder: join(runtime.value.dataDir, "folders", id) };
				if (location !== undefined) await environmentMustExist(location, ctx);
				const parties = new Map<string, Member>();
				for (const member of given ?? []) {
					await partyMustExist(member, ctx);
					parties.set(keyOf(member), member);
				}
				const checked = (added ?? []).map(checkedThing);
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
					});
					let position = 0;
					for (const [member, { access }] of parties)
						tx.put(members, { session, member, access, position: position++ });
					for (const [at, thing] of checked.entries()) putThing(tx, id, crypto.randomUUID(), at, by, thing);
					return null;
				}, ctx);
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
			removePerson: ({ person }, ctx) =>
				self.tx(async (tx) => {
					const member = `person:${person}`;
					// Index `by_member`: every session they are in, no cap (a membership left over would grant access).
					for await (const row of tx.rows(
						members,
						query(Members).where((m) => eq(m.member, member)),
					)) {
						await deleteMember(tx, row.session.params.id, member);
					}
					// Index `by_bringer`: what they brought into sessions they are no member of any more.
					for await (const row of tx.rows(
						things,
						query(Things).where((t) => eq(t.by, member)),
					)) {
						await deleteThing(tx, row.session.params.id, row.thing);
					}
					return null;
				}, ctx),
			addThing: async ({ session, thing, by }, ctx) => {
				const checked = checkedThing(thing);
				const id = crypto.randomUUID();
				await self.tx(async (tx) => {
					await mustExist(tx, session);
					putThing(tx, session, id, await nextThing(tx, session), by, checked);
					return null;
				}, ctx);
				return id;
			},
			removeThing: ({ session, thing }, ctx) =>
				self.tx(async (tx) => {
					await deleteThing(tx, session, thing);
					return null;
				}, ctx),
			setOptions: ({ session, thing, for: by, options: given }, ctx) =>
				self.tx(async (tx) => {
					const address = Session({ id: session });
					const found = await tx.get(things, { session: address, thing });
					if (found === undefined) throw invalid("args", `sessions: session ${session} has no thing ${thing}`);
					const { kind } = kindOf(found.kind);
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
					const value = (given ?? kind.initial) as JsonValue;
					const failed = checkValue(kind.options, value);
					if (failed !== undefined) throw invalid("args", `sessions: options of ${kind.name}: ${failed}`);
					tx.put(options, { ...key, version: kind.version, options: value });
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

/** The store's named queries over its tables `rows`, `members` and `options` (see each one's comment for its index). */
function namedQueries(
	self: StoreSelf<P3Principal>,
	{
		rows,
		members,
		options,
	}: {
		readonly rows: TableOf<typeof Rows>;
		readonly members: TableOf<typeof Members>;
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
				partnerReads: ["app", "title", "environment", "folder", "createdAt", "state", "lastTouch", "archivedAt"],
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
		// A thing's default options are its `everyone` options: the things' queries are driven from them, each
		// joined with its thing by the thing's key.
		things: self.queries(
			options,
			{
				map: (row, thing) => ({
					thing: row.thing,
					kind: thing.kind as string,
					ref: thing.ref as string,
					by: bringerOf(thing.by as string),
					options: row.options as JsonValue,
				}),
				reads: ["thing", "options"],
				partnerReads: ["kind", "ref", "by"],
			},
			{
				// The key's prefix `session`, `for` filtered. Ordered by the thing's `position`, a column of the
				// partner: SQLite sorts the session's things (a few).
				of: ({ session }: { session: string }) =>
					query(Options)
						.where((o) => and(eq(o.session, Session({ id: session })), eq(o.for, "everyone")))
						.join(ThingColumns, (o) => ({ session: o.session, thing: o.thing }))
						.orderBy((_o, thing) => thing.position, "asc"),
				// The key.
				one: ({ session, thing }: { session: string; thing: string }) =>
					query(Options)
						.where((o) => and(eq(o.session, Session({ id: session })), eq(o.thing, thing), eq(o.for, "everyone")))
						.join(ThingColumns, (o) => ({ session: o.session, thing: o.thing })),
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
			},
		),
	};
}

/** A table row as lists and a session's worker see it. */
function shown({ id, environment, folder, state, archivedAt, ...row }: Row): SessionRow {
	// `state` holds only what this plugin wrote: a `SessionState`.
	return {
		id: id.params.id,
		...row,
		location: { environment, folder },
		state: state as SessionState,
		archivedAt: archivedAt === 0 ? null : archivedAt,
	};
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

/** Who brought a thing, in the tables: `owner`, `app` (also when nobody is named: apps' server code), `person:<id>`. */
function bringerKey(by: Bringer | undefined): string {
	return by === undefined || by.kind !== "person" ? (by?.kind ?? "app") : `person:${by.id}`;
}

/** Who brought a thing, of its key in the tables (written by `bringerKey`). */
function bringerOf(key: string): Bringer {
	return key === "owner" || key === "app" ? { kind: key } : { kind: "person", id: key.slice("person:".length) };
}

/** Whose options in the tables: `everyone`, `agent`, `person:<id>`, `group:<id>`. */
function forKey(by: OptionsFor): string {
	return by.kind === "everyone" || by.kind === "agent" ? by.kind : keyOf(by);
}
