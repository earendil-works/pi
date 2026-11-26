// The plans of the things store's named queries, as SQLite runs them: each read (its first page and the page after a
// bookmark) searches the index its comment names, or the key, with no temporary B-tree; and the reads of the writes
// that look rows up (unlink, a thing's removal, the cleanup by source) search an index too. The test opens the store
// on a SQLite database of its own and records the statements Chord prepares while each query reads.

import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, it } from "node:test";
import { NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import {
	BACKGROUND_CONTEXT as context,
	createHost,
	openStore,
	type P3Principal,
	Server,
	sqliteBackend,
} from "@earendil-works/p3/v1";
import { ThingsStore } from "../contract.server.ts";
import type { Source } from "../contract.ts";
import { BOARD, Board } from "./kinds.ts";
import { THINGS } from "./world.ts";

/** A query's pages, read once each. */
type Read = () => Promise<unknown>;

describe("the plans of the things store's queries", () => {
	it("search their index or the key, and never sort", async () => {
		const database = new DatabaseSync(":memory:");
		const prepare = database.prepare.bind(database);
		const reads = new Set<string>();
		database.prepare = (sql) => {
			const statement = prepare(sql);
			if (!sql.startsWith("SELECT ") || !sql.includes("things.store:")) return statement;
			const all = statement.all.bind(statement);
			const iterate = statement.iterate.bind(statement);
			// Chord passes positional parameters only.
			const recorded = (...parameters: SQLInputValue[]) => {
				reads.add(sql);
				return all(...parameters);
			};
			const iterated = (...parameters: SQLInputValue[]) => {
				reads.add(sql);
				return iterate(...parameters);
			};
			return Object.assign(statement, { all: recorded, iterate: iterated });
		};
		const store = await openStore(sqliteBackend(new NodeSqliteDatabase(database)), context);
		const host = createHost<P3Principal>({
			address: Server(),
			principal: { kind: "server" },
			store,
			onError: (e) => assert.fail(e.kind),
		});
		try {
			await host.load([THINGS, BOARD], context);
			const things = await host.get(ThingsStore, {}, context);
			const by: Source = { kind: "plugin", plugin: "test" };
			const pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
			const team = await things.createWorkspace({ kind: "things.workspace", name: "team", parent: pi, by }, context);
			await things.createWorkspace({ kind: "things.workspace", name: "other", parent: pi, by }, context);
			const ann = await things.createPerson({ name: "Ann", madeBy: by }, context);
			await things.createPerson({ name: "Ben", madeBy: by }, context);
			const group = await things.makeGroup({ name: "g", managedBy: { kind: "people" }, outside: false }, context);
			await things.addToGroup({ group, person: ann, source: by }, context);
			await things.setGroupManagers(
				{ group, parties: [{ kind: "person", person: ann }, { kind: "everyone" }] },
				context,
			);
			const ids: string[] = [];
			for (const workspace of [team, team, pi])
				ids.push(
					await things.create(
						{ kind: Board.name, name: "b", workspace, by: { kind: "person", person: ann } },
						context,
					),
				);
			for (const party of [
				{ kind: "person", person: ann },
				{ kind: "group", group },
			] as const) {
				await things.putParty({ workspace: team, party, source: by }, context);
				await things.setSwitch({ workspace: team, item: { kind: "party", party }, shown: true }, context);
			}
			await things.setSwitch({ workspace: team, item: { kind: "thing", thing: ids[2]! }, shown: false }, context);
			/** The plans of the statements `read` makes Chord prepare. */
			const plansOf = async (read: Read): Promise<string[]> => {
				reads.clear();
				await read();
				assert.ok(reads.size > 0);
				const plan = (sql: string) =>
					prepare(`EXPLAIN QUERY PLAN ${sql}`).all(
						...sql
							.split("?")
							.slice(1)
							.map(() => 0),
					);
				return [...reads].flatMap((sql) => plan(sql).map((step) => String(step.detail)));
			};
			/** A named query's first page and the page after it. */
			const pages = <A>(
				query: { page(args: A, n: number, ctx: typeof context, o?: { after: string }): Promise<{ next?: string }> },
				args: A,
			): Read[] => [
				() => query.page(args, 1, context),
				async () => {
					const first = await query.page(args, 1, context);
					return first.next === undefined ? undefined : query.page(args, 1, context, { after: first.next });
				},
			];
			const T = "things.store:things";
			const person = `person/${ann}`;
			const cases: readonly (readonly [string, readonly Read[], string | undefined])[] = [
				["things.one", pages(things.things.one, { thing: ids[0]! }), undefined],
				["things.ofIds", pages(things.things.ofIds, { things: ids }), undefined],
				["things.madeBy", pages(things.things.madeBy, { sourceKey: person }), `${T}.things:by_maker`],
				["things.ofKind", pages(things.things.ofKind, { kind: Board.name }), `${T}.things:by_kind`],
				["workspaces.one", pages(things.workspaces.one, { workspace: team }), undefined],
				["workspaces.children", pages(things.workspaces.children, { parent: pi }), `${T}.workspaces:children`],
				["workspaces.under", pages(things.workspaces.under, { pathPrefix: `${pi}/` }), `${T}.workspaces:under`],
				["links.here", pages(things.links.here, { workspace: team }), undefined],
				["links.where", pages(things.links.where, { thing: ids[0]! }), `${T}.links:by_thing`],
				["workspaceMembers.here", pages(things.workspaceMembers.here, { workspace: team }), undefined],
				[
					"workspaceMembers.where",
					pages(things.workspaceMembers.where, { partyKey: person }),
					`${T}.workspace_members:by_party`,
				],
				[
					"workspaceMembers.ofParties",
					pages(things.workspaceMembers.ofParties, {
						workspaces: [team, pi],
						partyKeys: [person, `group/${group}`],
					}),
					undefined,
				],
				["switches.here", pages(things.switches.here, { workspace: team }), undefined],
				[
					"switches.ofItems",
					pages(things.switches.ofItems, { workspaces: [team, pi], itemKeys: [person, `group/${group}`] }),
					undefined,
				],
				["grants.here", pages(things.grants.here, { workspace: team }), undefined],
				["grants.of", pages(things.grants.of, { workspace: team, thing: ids[0]! }), undefined],
				["grants.ofParty", pages(things.grants.ofParty, { partyKey: "everyone" }), `${T}.grants:by_party`],
				["grants.ofThing", pages(things.grants.ofThing, { thing: ids[0]! }), `${T}.grants:by_thing`],
				["persons.one", pages(things.persons.one, { person: ann }), undefined],
				["persons.ofIds", pages(things.persons.ofIds, { persons: [ann, "none"] }), undefined],
				["persons.owners", pages(things.persons.owners, {}), `${T}.persons:by_owner`],
				["groups.one", pages(things.groups.one, { group }), undefined],
				["groups.ofIds", pages(things.groups.ofIds, { groups: [group, "none"] }), undefined],
				["groupManagers.of", pages(things.groupManagers.of, { group }), undefined],
				[
					"groupMembers.ofPerson",
					pages(things.groupMembers.ofPerson, { person: ann }),
					`${T}.group_members:by_person`,
				],
				["groupMembers.ofGroup", pages(things.groupMembers.ofGroup, { group }), undefined],
			];
			for (const [name, read, expected] of cases) {
				const plans = (await Promise.all(read.map((each) => plansOf(each)))).flat();
				const own = plans.find((step) => /^(SEARCH|SCAN) t USING /.test(step));
				const index =
					expected === undefined
						? /^SEARCH t USING PRIMARY KEY /
						: new RegExp(`^(SEARCH|SCAN) t USING (COVERING )?INDEX ${escaped(expected)}( |$)`);
				assert.match(own ?? "", index, `${name}: ${plans.join(" | ")}`);
				assert.ok(!plans.some((step) => step.includes("TEMP B-TREE")), `${name}: ${plans.join(" | ")}`);
				// A joined set (a grant's thing, a membership's group) is found by its key.
				for (const step of plans.filter((each) => /^(SEARCH|SCAN) p /.test(each))) {
					assert.match(step, /^SEARCH p USING PRIMARY KEY /, `${name}: ${plans.join(" | ")}`);
				}
			}
			// The writes that look rows up: an unlink that removes the thing with its last link, and a cleanup by source.
			for (const write of [
				() => things.unlink({ workspace: pi, thing: ids[2]! }, context),
				() => things.deleteEverythingFrom({ source: by }, context),
			]) {
				const plans = await plansOf(write);
				for (const step of plans.filter((each) => !/^(LIST SUBQUERY|SCAN json_each)/.test(each))) {
					assert.ok(/^SEARCH [tp] USING /.test(step) && !step.includes("TEMP B-TREE"), plans.join(" | "));
				}
			}
		} finally {
			await host.close(context);
			await store.close(context);
		}
	});
});

/** `text` as a literal in a regular expression. */
function escaped(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
