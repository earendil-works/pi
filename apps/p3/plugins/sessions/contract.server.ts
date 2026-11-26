// The sessions plugin's contract for server facets: the store of the sessions, their members and things, which apps
// call from their server code to manage their sessions (the owner's `Sessions` calls it too), and whose named queries
// other server objects read; the registry of the kinds of things, and `serveThing`, a kind's server side in one call.
// `/v1/server` re-exports it.

import {
	type AdmittedOf,
	arr,
	bool,
	type Contract,
	type Ctx,
	contribute,
	defineRegistry,
	type FacetHost,
	type GrantableName,
	type Implementation,
	type JsonValue,
	local,
	method,
	nul,
	num,
	obj,
	opt,
	type P3Principal,
	type ParamsOf,
	queries,
	type Schema,
	type Self,
	str,
	type TableItem,
	union,
	unknown,
} from "@earendil-works/p3/v1";
import {
	type Access,
	admitThing,
	Bringer,
	Location,
	Member,
	OptionsFor,
	Party,
	SessionRow,
	SessionState,
	SessionThing,
	Thing,
	ThingKeeper,
	type ThingKind,
	ThingName,
	ThingOwner,
	ThingUse,
	Title,
} from "./contract.ts";

/**
 * The sessions, once per server: their rows, members and things as named queries, and every write. Server code only
 * (an app's server facet, the owner's views): it acts for the Pi and checks no caller.
 */
export const SessionsStore = local("sessions.store", {
	version: 1,
	params: {},
	members: {
		sessions: queries(SessionRow, {
			/** An app's sessions that are not archived, the last touched first. */
			active: obj({ app: str() }),
			/** An app's archived sessions, the last archived first. */
			archived: obj({ app: str() }),
			/** The session `id`, if there is one. */
			one: obj({ id: str() }),
		}),
		members: queries(Member, {
			/** Session `session`'s members, in the order they were added. */
			of: obj({ session: str() }),
		}),
		/** The sessions an app's members (persons and groups by key, `person:<id>`, `group:<id>`) are in. */
		memberships: queries(SessionRow, {
			/** Of `members` in `app`, active, the last touched first. */
			active: obj({ app: str(), members: arr(str()) }),
			/** Of `members` in `app`, archived, the last archived first. */
			archived: obj({ app: str(), members: arr(str()) }),
		}),
		/** The things themselves (their owner the sessions plugin's), whoever uses them. */
		things: queries(Thing, {
			/** The thing `id`, if there is one. */
			one: obj({ id: str() }),
			/**
			 * The things of `owners` (keys `person:<id>`, `group:<id>`, `pi`) whose name starts with `prefix` (`""`:
			 * every one), by owner, then name.
			 */
			owned: obj({ owners: arr(str()), prefix: ThingName }),
			/** The things of `owners` (keys as `owned`) "in all my sessions": what a session following them has, by owner. */
			everywhere: obj({ owners: arr(str()) }),
			/** The things of kind `kind` that `owner` (a key as `owned`) owns, the first made first ("the Pi's coding tools"). */
			ofKind: obj({ owner: str(), kind: str() }),
		}),
		/** Which session uses which thing (links), each with the thing's kind, name and owner. */
		links: queries(SessionThing, {
			/** Session `session`'s things, in the order they were linked. */
			of: obj({ session: str() }),
			/** Thing `thing` in session `session`, if the session uses it. */
			one: obj({ session: str(), thing: str() }),
			/** The sessions thing `thing` is in, by session. */
			ofThing: obj({ thing: str() }),
		}),
		/** The options set for one thing of a session, by whom (`everyone`, `agent`, `person:<id>`, `group:<id>`). */
		options: queries(obj({ thing: str(), for: str(), version: num(), options: unknown() }), {
			/** Every option set for thing `thing` of session `session`. */
			of: obj({ session: str(), thing: str() }),
			/** The options `for` set for every thing of session `session`, by thing. */
			ofSession: obj({ session: str(), for: str() }),
			/** Every option set in session `session`, by thing, then by whom. */
			inSession: obj({ session: str() }),
		}),
		/**
		 * Makes a session with its members and things in one commit; answers its id. Without a location it works on
		 * this device in a folder the sessions plugin makes for it (`<data directory>/folders/<id>`). Its things
		 * (new ones made, existing ones linked) are linked by `by` (the app when left out).
		 */
		create: method(
			obj({
				app: str(),
				title: opt(Title),
				location: opt(Location),
				members: opt(arr(Member)),
				things: opt(arr(ThingUse)),
				by: opt(Bringer),
				/** Whom it follows (see `SessionRow`); left out: nobody. */
				follows: opt(union([Party, nul()])),
			}),
			str(),
		),
		/**
		 * As `Sessions.follow`: whom session `session` follows; with `keep` (the default) what it had from them is
		 * linked, by `by` (the app when left out).
		 */
		follow: method(obj({ session: str(), follows: union([Party, nul()]), keep: opt(bool()), by: opt(Bringer) })),
		rename: method(obj({ session: str(), title: Title })),
		archive: method(obj({ session: str() })),
		restore: method(obj({ session: str() })),
		addMember: method(obj({ session: str(), member: Member })),
		/**
		 * Removes a member, the options set for it, and the links of the things it owns (a person's, a group's): the
		 * session's content stays.
		 */
		removeMember: method(obj({ session: str(), party: Party })),
		/**
		 * Makes a thing of `kind` for `owner` (its kind's `create` runs after the commit with `input`; a throw there
		 * deletes the thing again and fails the call); with `session`, links it there by `by` (the app when left out)
		 * with its default options. A thing nobody owns is made only into a session. Answers its id.
		 */
		createThing: method(
			obj({
				kind: str(),
				name: opt(ThingName),
				owner: ThingOwner,
				input: opt(unknown()),
				session: opt(str()),
				by: opt(Bringer),
				options: opt(unknown()),
				/** "In all my sessions"; left out: true for an owned thing made outside a session, false otherwise. */
				everywhere: opt(bool()),
			}),
			str(),
		),
		/**
		 * The thing of `kind` that `owner` owns, made in this commit if there is none ("in all my sessions" unless
		 * `everywhere` is false): how a plugin makes its one thing (the Pi's coding tools) at its start; answers its id.
		 */
		ensureThing: method(
			obj({ kind: str(), owner: ThingKeeper, name: opt(ThingName), everywhere: opt(bool()) }),
			str(),
		),
		/** Whether sessions following thing `thing`'s owner have it. */
		setEverywhere: method(obj({ thing: str(), everywhere: bool() })),
		/** Links thing `thing` to session `session` by `by` (the app when left out), with its default options there. */
		addThing: method(obj({ session: str(), thing: str(), by: opt(Bringer), options: opt(unknown()) })),
		/** Unlinks a thing and its options there; a thing nobody owns is deleted with its last link. */
		removeThing: method(obj({ session: str(), thing: str() })),
		/** Gives thing `thing` an owner; it is not "in all my sessions" until they say so. */
		keepThing: method(obj({ thing: str(), owner: ThingKeeper })),
		/** Names thing `thing`, the same in every session (empty: its kind's title). */
		renameThing: method(obj({ thing: str(), name: ThingName })),
		/** Deletes thing `thing` everywhere: its links, their options, its content (its kind's `delete`). */
		deleteThing: method(obj({ thing: str() })),
		setOptions: method(obj({ session: str(), thing: str(), for: OptionsFor, options: unknown() })),
		/**
		 * Person `person` left the Pi (the people plugin calls it): removed from every session with the options set
		 * for them, and the things they own deleted (their groups' stay).
		 */
		removePerson: method(obj({ person: str() })),
		/** Session `session`'s agent is in `state` now: its row says so, and it is touched. */
		report: method(obj({ session: str(), state: SessionState })),
		/** The ids of every session whose agent is working and that is not archived, all of them: the waker's. */
		working: method(obj({}), arr(str())),
	},
});

/**
 * How things of a kind come to exist:
 * - `content` (a canvas, notes, a checklist): any writer of a session, or its agent, makes one there, owned by nobody;
 * - `person` (a login, an inbox, an MCP server): a person makes one for themselves, a group of theirs, or (the owner)
 *   the Pi, outside sessions (`MyThings`), never through the agent;
 * - `plugin` (the coding tools): only server code makes them (`ensureThing`), so nobody makes a second one with
 *   other options. The default: a kind that says nothing is safe.
 */
export type ThingCreation = "content" | "person" | "plugin";

/**
 * A kind of thing as its plugin offers it: the kind (its options' schema, version, initial), its title, how its
 * things come to exist (`creation`, see `ThingCreation`; default `plugin`), and its hooks. The sessions plugin makes every thing and its id; `create` sets up the thing's content after its commit
 * (most kinds do nothing), with the `input` its creation took (a sign-in's, collected by the kind's creation view;
 * checked against `input`, and none is accepted without it); `delete` drops a thing's content when the thing goes.
 */
export type ThingKindEntry = {
	readonly kind: ThingKind<JsonValue>;
	readonly title: string;
	readonly creation?: ThingCreation;
	readonly input?: Schema<JsonValue>;
	readonly create?: (
		thing: { readonly id: string; readonly name: string; readonly owner: ThingOwner },
		input: JsonValue | undefined,
		ctx: Ctx<P3Principal>,
	) => Promise<void>;
	readonly delete?: (thing: string, ctx: Ctx<P3Principal>) => Promise<void>;
};

/** The kinds of things by name, each with its plugin: what `addThing` and `setOptions` check options against. */
export const ThingKinds = defineRegistry<ThingKindEntry, ReadonlyMap<string, TableItem<ThingKindEntry>>>(
	"sessions.thing-kinds",
	{ version: 1 },
);

/** A kind's object for one of its things: its contract (admitted by `thingAdmission(Kind)`) and its factory. */
export type ThingObject<O extends JsonValue, C extends Contract> = {
	/** A remote contract with params `{ session, thing }` and `admission: thingAdmission(Kind)`. */
	readonly contract: AdmittedOf<C> extends { access: Access; options: O }
		? ParamsOf<C> extends { session: string; thing: string }
			? C
			: never
		: never;
	/** What a caller the thing's admission let in is granted of the object's grantable members (none without it). */
	readonly grants?: (admitted: { readonly access: Access; readonly options: O }) => readonly GrantableName<C>[];
	/** The object for a caller the thing's admission let in: their access, the options that apply to them, the grant. */
	readonly factory: (
		params: ParamsOf<C>,
		admitted: { readonly access: Access; readonly options: O; readonly granted: ReadonlySet<GrantableName<C>> },
		self: Self<P3Principal>,
	) => Implementation<C, Ctx<P3Principal>>;
};

/**
 * Serves kind `kind` on `host`, a kind's whole server side in one call: its `ThingKinds` entry (title, input, hooks;
 * see `ThingKindEntry`), and with `object` its thing object, admitted by `admitThing(kind)`.
 */
export function serveThing<O extends JsonValue, C extends Contract = never>(
	host: FacetHost<P3Principal>,
	kind: ThingKind<O>,
	spec: Omit<ThingKindEntry, "kind"> & { readonly object?: ThingObject<O, C> },
): void {
	const { object, ...entry } = spec;
	// The entry holds the kind as every kind's entry does: its options as JSON, checked by the store at each write.
	contribute(host, `${kind.name}.kind`, (self) => self.contribute(ThingKinds, { ...entry, kind } as ThingKindEntry));
	if (object === undefined) return;
	const factory = (params: ParamsOf<C>, _principal: P3Principal, admitted: AdmittedOf<C>, self: Self<P3Principal>) =>
		// The contract's admission is `thingAdmission(kind)`, as its type says: the value is the caller's access, options
		// and grant.
		object.factory(
			params,
			admitted as unknown as { access: Access; options: O; granted: ReadonlySet<GrantableName<C>> },
			self,
		);
	// `C` is generic here: Chord's factory and option types cannot be resolved for it, the call is checked at `ThingObject`.
	(host.serve as (type: Contract, factory: unknown, options: unknown) => void)(object.contract, factory, {
		// `GrantableName<C>` is a string for every contract; `C` generic here, TypeScript cannot see it.
		admit: admitThing(
			kind,
			object.grants as ((admitted: { access: Access; options: O }) => readonly string[]) | undefined,
		),
	});
}
