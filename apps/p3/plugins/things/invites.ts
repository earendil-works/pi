// Invite links (decision 110, R17, R39): whoever has Manage people in a workspace writes one, as a member (a
// `things.workspace-members` entry) or a guest (a membership in the workspace's own outside Guests group only, so the
// guest counts as that group, not as themself or everyone here). A link is valid 7 days unless it says otherwise, used
// up by its first use unless it is for several, and may put its redeemer into a group too. Its secret is kept hashed
// in `things.invites`: the link is `<invite>.<secret>`, the secret never stored.

import { and, eq, invalid, query, type Tx } from "@earendil-works/p3/v1";
import { hashToken, matchesHash, newToken } from "@earendil-works/p3/v1/server";
import type { Touched } from "./access.ts";
import { managedByKey, type Party, type Source, sourceKey } from "./contract.ts";
import { Groups, type PeopleTables, type PeopleWrites } from "./people.ts";

/** How long a link is valid unless it says: 7 days (R39). */
const DEFAULT_EXPIRES = 7 * 24 * 60 * 60_000;

/** What an invite link is made with. */
export type InviteArgs = {
	readonly workspace: string;
	readonly name: string;
	readonly as: "member" | "guest";
	readonly expires?: number;
	readonly uses?: "one" | "several";
	readonly group?: string;
	readonly by: Source;
};

/** Whom a redeemed link signs in. */
export type Invited = { readonly person: string; readonly name: string };

/** What redeeming needs of the store's other writes: putting a party into a workspace, under the same transaction. */
export type PutParty = (
	tx: Tx,
	touched: Touched,
	args: { workspace: string; party: Party; source: Source },
) => Promise<null>;

/** The source of what the things plugin itself writes (a workspace's Guests group put into it). */
const THINGS: Source = { kind: "plugin", plugin: "@earendil-works/p3-things" };

/** The writes of invite links inside a store transaction; none checks a caller. */
export class InviteWrites {
	readonly #t: PeopleTables;
	readonly #people: PeopleWrites;
	readonly #putParty: PutParty;

	constructor(t: PeopleTables, people: PeopleWrites, putParty: PutParty) {
		this.#t = t;
		this.#people = people;
		this.#putParty = putParty;
	}

	/** Writes a new link (the workspace and group must exist: `mustExist`); answers `<invite>.<secret>`. */
	async create(tx: Tx, args: InviteArgs, mustExist: (tx: Tx, workspace: string) => Promise<void>): Promise<string> {
		await mustExist(tx, args.workspace);
		if (args.group !== undefined && (await tx.get(this.#t.groups, { group: args.group })) === undefined) {
			throw invalid("args", `things: no group ${args.group}`);
		}
		const invite = crypto.randomUUID();
		const secret = newToken();
		tx.put(this.#t.invites, {
			invite,
			hash: hashToken(secret),
			workspace: args.workspace,
			as: args.as,
			name: args.name,
			expires: Date.now() + (args.expires ?? DEFAULT_EXPIRES),
			several: args.uses === "several",
			group: args.group ?? "",
			by: args.by,
			byKey: sourceKey(args.by),
		});
		return `${invite}.${secret}`;
	}

	/**
	 * Redeems `link` for `person` (signed in) or a new person made by the link's maker: puts them in as the link says;
	 * a link for one use goes. `undefined` for a link that is unknown, expired (it goes) or whose secret does not match.
	 */
	async redeem(tx: Tx, touched: Touched, link: string, person: string | undefined): Promise<Invited | undefined> {
		const dot = link.indexOf(".");
		if (dot <= 0) return undefined;
		const invite = link.slice(0, dot);
		const row = await tx.get(this.#t.invites, { invite });
		if (row === undefined || !matchesHash(link.slice(dot + 1), row.hash)) return undefined;
		if (row.expires <= Date.now() || !row.several) tx.delete(this.#t.invites, { invite });
		if (row.expires <= Date.now()) return undefined;
		const who = await this.#redeemer(tx, person, row.name, row.by);
		if (who === undefined) return undefined;
		const party: Party = { kind: "person", person: who.person };
		if (row.as === "member") await this.#putParty(tx, touched, { workspace: row.workspace, party, source: row.by });
		else {
			const guests = await this.#guestsOf(tx, touched, row.workspace);
			await this.#people.addToGroup(tx, touched, { group: guests, person: who.person, source: row.by });
		}
		if (row.group !== "" && (await tx.get(this.#t.groups, { group: row.group })) !== undefined) {
			await this.#people.addToGroup(tx, touched, { group: row.group, person: who.person, source: row.by });
		}
		return who;
	}

	/** The person a link is redeemed for: `person` if they exist, else a new one named `name`, made by `by`. */
	async #redeemer(tx: Tx, person: string | undefined, name: string, by: Source): Promise<Invited | undefined> {
		if (person === undefined) return { person: this.#people.createPerson(tx, { name, madeBy: by }), name };
		const row = await tx.get(this.#t.persons, { person });
		return row === undefined ? undefined : { person, name: row.name };
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
		const group = this.#people.makeGroup(tx, {
			name: "Guests",
			managedBy: { kind: "workspace", workspace },
			outside: true,
			managers: [],
		});
		await this.#putParty(tx, touched, { workspace, party: { kind: "group", group }, source: THINGS });
		return group;
	}
}
