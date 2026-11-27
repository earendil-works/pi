// Invite links (decision 110, R17, R39): whoever has Manage people in a workspace writes one, as a member (a
// `things.workspace-members` entry) or a guest (a membership in the workspace's own outside Guests group only, so the
// guest counts as that group, not as themself or everyone here). A link is valid 7 days unless it says otherwise, used
// up by its first use unless it is for several, and may put its redeemer into a group too. Its secret is kept hashed
// in `things.invites`: the link is `<invite>.<secret>`, the secret never stored. Its maker's rights are checked again
// when it is redeemed: a link stays good only while its maker may still write it.

import { and, type Context, eq, invalid, lte, query, type TableOf, type Tx } from "@earendil-works/p3/v1";
import { hashToken, matchesHash, newToken } from "@earendil-works/p3/v1/server";
import type { Asks, Touched } from "./access.ts";
import type { Invited, InviteInput } from "./contract.server.ts";
import { type Caller, managedByKey, type Party, type Source, sourceKey } from "./contract.ts";
import { messages } from "./messages.ts";
import { Groups, Invites, type PeopleTables, type PeopleWrites, THINGS } from "./people.ts";

/** How long a link is valid unless it says: 7 days (R39). */
const DEFAULT_EXPIRES = 7 * 24 * 60 * 60_000;

/** What invite links need of the store's writes on workspaces and groups, under the same transaction. */
export type Places = {
	putParty(tx: Tx, touched: Touched, args: { workspace: string; party: Party; source: Source }): Promise<null>;
	mustBeWorkspace(tx: Tx, workspace: string): Promise<void>;
	isWorkspace(tx: Tx, workspace: string): Promise<boolean>;
	/** Whether `party` has an entry of its own in `workspace` (of any source). */
	isPutIn(tx: Tx, workspace: string, party: Party): Promise<boolean>;
	/** Whether `by` may change `group`'s members: its own tick (or the owner flag) on a group people manage. */
	mayChange(tx: Tx, group: string, by: Source): Promise<boolean>;
};

/** How many expired links one sweep takes (at the start, at each new link): bounded, so a sweep never runs long. */
const SWEEP = 100;

/** The links expired by `now`, the oldest first (index `by_expiry`): what a sweep takes. */
function expiredBy(now: number) {
	return query(Invites)
		.where((r) => lte(r.expires, now))
		.orderBy((r) => r.expires, "asc");
}

/** Whether any link has expired by `now` (one row read, outside a transaction: the start's question). */
export async function anyExpired(invites: TableOf<typeof Invites>, now: number, context: Context): Promise<boolean> {
	return (await invites.page(expiredBy(now), 1, context)).items.length > 0;
}

/** The writes of invite links inside a store transaction; none checks a caller. */
export class InviteWrites {
	readonly #t: PeopleTables;
	readonly #people: PeopleWrites;
	readonly #places: Places;

	constructor(t: PeopleTables, people: PeopleWrites, places: Places) {
		this.#t = t;
		this.#people = people;
		this.#places = places;
	}

	/**
	 * Writes a new link (the workspace and group must exist, and its maker must be one who may change the group:
	 * scenario 18); answers `<invite>.<secret>`. Expired links are swept, a bounded number each time.
	 */
	async create(tx: Tx, args: InviteInput): Promise<string> {
		await this.#places.mustBeWorkspace(tx, args.workspace);
		if (args.group !== undefined) {
			if ((await tx.get(this.#t.groups, { group: args.group })) === undefined) {
				throw invalid("args", `things: no group ${args.group}`);
			}
			if (!(await this.#places.mayChange(tx, args.group, args.by))) {
				throw invalid("args", `things: ${sourceKey(args.by)} may not add people to ${args.group}`, {
					message: messages.message("groupNotManaged"),
				});
			}
		}
		const now = Date.now();
		await this.sweep(tx, now);
		const invite = crypto.randomUUID();
		const secret = newToken();
		tx.put(this.#t.invites, {
			invite,
			hash: hashToken(secret),
			workspace: args.workspace,
			as: args.as,
			name: args.name,
			expires: now + (args.expires ?? DEFAULT_EXPIRES),
			several: args.uses === "several",
			group: args.group ?? "",
			by: args.by,
			byKey: sourceKey(args.by),
		});
		return `${invite}.${secret}`;
	}

	/**
	 * Redeems `link` for `person` (signed in) or a new person made by the link's maker: puts them in as the link says,
	 * keeping an entry they have already (its source stays); a link for one use goes. `null` for a link that is
	 * unknown, expired (it goes), whose secret does not match, into a workspace that is gone (it goes), whose maker may
	 * no longer put people into its group, or for a person who does not exist (the link stays good). Its maker's Manage
	 * people is checked before, in the same operation (`makerMay`).
	 */
	async redeem(tx: Tx, touched: Touched, link: string, person: string | undefined): Promise<Invited | null> {
		const dot = link.indexOf(".");
		if (dot <= 0) return null;
		const invite = link.slice(0, dot);
		const row = await tx.get(this.#t.invites, { invite });
		if (row === undefined || !matchesHash(link.slice(dot + 1), row.hash)) return null;
		const now = Date.now();
		const { workspace, by: source } = row;
		const gone = row.expires <= now || !(await this.#places.isWorkspace(tx, workspace));
		if (gone) {
			tx.delete(this.#t.invites, { invite });
			return null;
		}
		if (person !== undefined && (await tx.get(this.#t.persons, { person })) === undefined) return null;
		// Its maker may still put people into its group: the group's own tick, or the owner flag (scenario 18).
		if (row.group !== "" && !(await this.#places.mayChange(tx, row.group, row.by))) return null;
		if (!row.several) tx.delete(this.#t.invites, { invite });
		const who = await this.#redeemer(tx, person, row.name, row.by);
		const party: Party = { kind: "person", person: who.person };
		if (row.as === "member") {
			if (!(await this.#places.isPutIn(tx, workspace, party)))
				await this.#places.putParty(tx, touched, { workspace, party, source });
		} else {
			const guests = await this.#guestsOf(tx, touched, workspace);
			await this.#people.addToGroup(tx, touched, { group: guests, person: who.person, source });
		}
		if (row.group !== "" && (await tx.get(this.#t.groups, { group: row.group })) !== undefined) {
			await this.#people.addToGroup(tx, touched, { group: row.group, person: who.person, source });
		}
		return who;
	}

	/**
	 * Whether the maker of link `link` still has Manage people in the workspace it points into, as the index answers
	 * now (`asks`, in the redeeming write's operation); server code (a plugin, a thing, a provider) always. A link
	 * that is unknown answers true: the redeeming write refuses it.
	 */
	async makerMay(link: string, asks: Asks, context: Context): Promise<boolean> {
		const dot = link.indexOf(".");
		if (dot <= 0) return true;
		const row = await this.#t.invites.get({ invite: link.slice(0, dot) }, context);
		if (row === undefined) return true;
		const caller = callerOfSource(row.by);
		if (caller === undefined) return true;
		const answer = await asks.answer(row.workspace, row.workspace, caller, context);
		return answer?.ticks.includes("managePeople") === true;
	}

	/** Deletes up to `SWEEP` links expired by `now` (index `by_expiry`). */
	async sweep(tx: Tx, now: number): Promise<null> {
		for (const { invite } of (await tx.page(this.#t.invites, expiredBy(now), SWEEP)).items) {
			tx.delete(this.#t.invites, { invite });
		}
		return null;
	}

	/** The person a link is redeemed for: `person` (who exists), else a new one named `name`, made by `by`. */
	async #redeemer(tx: Tx, person: string | undefined, name: string, by: Source): Promise<Invited> {
		if (person === undefined) return { person: await this.#people.createPerson(tx, { name, madeBy: by }), name };
		return { person, name: (await tx.get(this.#t.persons, { person }))!.name };
	}

	/** The workspace's own outside Guests group (R17), made and put into it at its first guest. */
	async #guestsOf(tx: Tx, touched: Touched, workspace: string): Promise<string> {
		const key = managedByKey({ kind: "workspace", workspace });
		const found = await tx.page(
			this.#t.groups,
			query(Groups).where((g) => and(eq(g.managedByKey, key), eq(g.outside, true))),
			1,
		);
		const existing = found.items[0]?.group;
		if (existing !== undefined) return existing;
		const managedBy = { kind: "workspace", workspace } as const;
		const group = await this.#people.makeGroup(tx, { name: "Guests", managedBy, outside: true });
		await this.#places.putParty(tx, touched, { workspace, party: { kind: "group", group }, source: THINGS });
		return group;
	}
}

/** The caller a link's maker is (a person, a session's agent); `undefined` for server code (a plugin, a thing, a provider). */
function callerOfSource(source: Source): Caller | undefined {
	switch (source.kind) {
		case "person":
			return { kind: "person", person: source.person };
		case "agent":
			return { kind: "agent", session: source.session };
		default:
			return undefined;
	}
}
