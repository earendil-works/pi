// The plans of the things store's named queries, as SQLite runs them: each read (its first page and the page after a
// bookmark) searches the index its comment names, or the key, with no temporary B-tree; and the reads of the writes
// that look rows up (unlink, a thing's removal, the cleanup by source, a person's and a group's removal) search an
// index too. Some reads are whole-table scans on purpose: the pending deletes (`things.pending`), removals
// (`things.removing`) and gone workspaces (`things.gone`), few rows each, read at the start and when the kinds' hooks
// change, and the sign-outs still to end (`things.sign-outs`), read at the start. The test opens the store on a SQLite
// database of its own and records the statements Chord prepares. The cleanup of a share (test 8) reads as much for 50
// guests as for 5, in one commit.

import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, it } from "node:test";
import { withTelemetry } from "@earendil-works/chord/context";
import { NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import {
	BACKGROUND_CONTEXT as context,
	createHost,
	openStore,
	type P3Principal,
	Server,
	sqliteBackend,
} from "@earendil-works/p3/v1";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { eventually } from "../../../test/until.ts";
import { ThingsStore } from "../contract.server.ts";
import type { Source } from "../contract.ts";
import { BOARD, Board } from "./kinds.ts";
import { RUNTIME, THINGS } from "./world.ts";

/** A query's pages, read once each. */
type Read = () => Promise<unknown>;

/**
 * A SQLite database in memory whose reads of the things store's tables are recorded: the statements since the last
 * `reads.clear()`, every one since the start (`ever`), and how many ran (`runs.count`).
 */
function recorded() {
	const database = new DatabaseSync(":memory:");
	const prepare = database.prepare.bind(database);
	const reads = new Set<string>();
	const ever = new Set<string>();
	const runs = { count: 0 };
	database.prepare = (sql) => {
		const statement = prepare(sql);
		if (!sql.startsWith("SELECT ") || !sql.includes("things.store:")) return statement;
		const all = statement.all.bind(statement);
		const iterate = statement.iterate.bind(statement);
		const ran = () => {
			reads.add(sql);
			ever.add(sql);
			runs.count++;
		};
		// Chord passes positional parameters only.
		const listed = (...parameters: SQLInputValue[]) => {
			ran();
			return all(...parameters);
		};
		const iterated = (...parameters: SQLInputValue[]) => {
			ran();
			return iterate(...parameters);
		};
		return Object.assign(statement, { all: listed, iterate: iterated });
	};
	return { database, prepare, reads, ever, runs };
}

describe("the plans of the things store's queries", () => {
	it("search their index or the key, and never sort", async () => {
		// Every statement read since the start (`ever`), the pending deletes' scan among them.
		const { database, prepare, reads, ever } = recorded();
		const store = await openStore(sqliteBackend(new NodeSqliteDatabase(database)), context);
		const host = createHost<P3Principal>({
			address: Server(),
			principal: { kind: "server" },
			store,
			onError: (e) => assert.fail(e.kind),
		});
		try {
			await host.load([THINGS, RUNTIME, BOARD], context);
			const things = await host.get(ThingsStore, {}, context);
			const by: Source = { kind: "plugin", plugin: "test" };
			const pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
			const team = await things.createWorkspace({ kind: "things.workspace", name: "team", parent: pi, by }, context);
			await things.createWorkspace({ kind: "things.workspace", name: "other", parent: pi, by }, context);
			const ann = await things.createPerson({ name: "Ann", madeBy: by }, context);
			await things.createPerson({ name: "Ben", madeBy: by }, context);
			const group = await things.makeGroup({ name: "g", managedBy: { kind: "people" }, outside: false }, context);
			await things.addToGroup({ group, person: ann, source: by }, context);
			const ben = await things.createPerson({ name: "Ben", madeBy: { kind: "person", person: ann } }, context);
			await things.addToGroup({ group, person: ben, source: { kind: "person", person: ann } }, context);
			await things.setGroupManagers(
				{
					group,
					parties: [
						{ kind: "person", person: ann },
						{ kind: "person", person: ben },
					],
				},
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
			/** The steps of the plan of statement `sql`. */
			const plan = (sql: string) =>
				prepare(`EXPLAIN QUERY PLAN ${sql}`)
					.all(
						...sql
							.split("?")
							.slice(1)
							.map(() => 0),
					)
					.map((step) => String(step.detail));
			/** The plans of the statements `read` makes Chord prepare. */
			const plansOf = async (read: Read): Promise<string[]> => {
				reads.clear();
				await read();
				assert.ok(reads.size > 0);
				return [...reads].flatMap(plan);
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
			const cases: readonly (readonly [string, readonly Read[], string | undefined])[] = [
				["things.one", pages(things.things.one, { thing: ids[0]! }), undefined],
				["things.ofIds", pages(things.things.ofIds, { things: [ids[0]!, ids[1]!, "none"] }), undefined],
				["workspaces.under", pages(things.workspaces.under, { pathPrefix: `${pi}/` }), `${T}.workspaces:under`],
				["links.where", pages(things.links.where, { thing: ids[0]! }), `${T}.links:by_thing`],
				[
					"things.ofMaker",
					pages(things.things.ofMaker, { sourceKey: `person/${ann}`, kind: Board.name }),
					`${T}.things:by_maker`,
				],
				["workspaces.one", pages(things.workspaces.one, { workspace: team }), undefined],
				["workspaces.children", pages(things.workspaces.children, { parent: pi }), `${T}.workspaces:children`],
				["links.here", pages(things.links.here, { workspace: team }), undefined],
				["workspaceMembers.here", pages(things.workspaceMembers.here, { workspace: team }), undefined],
				[
					"workspaceMembers.where",
					pages(things.workspaceMembers.where, { partyKey: `person/${ann}` }),
					`${T}.workspace-members:by_party`,
				],
				["groups.ofIds", pages(things.groups.ofIds, { groups: [group, "none"] }), undefined],
				["switches.here", pages(things.switches.here, { workspace: team }), undefined],
				["grants.here", pages(things.grants.here, { workspace: team }), undefined],
				["persons.one", pages(things.persons.one, { person: ann }), undefined],
				["persons.ofIds", pages(things.persons.ofIds, { persons: [ann, "none"] }), undefined],
				["persons.owners", pages(things.persons.owners, {}), `${T}.persons:by_owner`],
				[
					"groupMembers.ofPerson",
					pages(things.groupMembers.ofPerson, { person: ann }),
					`${T}.group-members:by_person`,
				],
				["groups.one", pages(things.groups.one, { group }), undefined],
				["groups.ofIds", pages(things.groups.ofIds, { groups: [group, "none"] }), undefined],
				[
					"workspaceMembers.where",
					pages(things.workspaceMembers.where, { partyKey: `person/${ann}` }),
					`${T}.workspace-members:by_party`,
				],
				["groupMembers.of", pages(things.groupMembers.of, { group, person: ann }), undefined],
				[
					"groupManagers.among",
					pages(things.groupManagers.among, { group, partyKeys: [`person/${ann}`, `person/${ben}`] }),
					undefined,
				],
				["groupManagers.of", pages(things.groupManagers.of, { group }), undefined],
				["groupMembersNamed.ofGroup", pages(things.groupMembersNamed.ofGroup, { group }), undefined],
			];
			// The owner's picker reads every person and group, in the key's order: a scan on purpose, never a sort.
			for (const read of [...pages(things.persons.all, {}), ...pages(things.groups.all, {})]) {
				const plans = await plansOf(read);
				assert.ok(!plans.some((step) => step.includes("TEMP B-TREE")), plans.join(" | "));
			}
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
			// The writes that look rows up: an unlink that removes the thing with its last link, a cleanup by source (the
			// persons it made among it), a person's removal and a group's, a tick set, a workspace's removal.
			const sub = await things.createWorkspace({ kind: "things.workspace", name: "sub", parent: team, by }, context);
			await things.create({ kind: Board.name, name: "b", workspace: sub, by }, context);
			for (const write of [
				() => things.unlink({ workspace: pi, thing: ids[2]! }, context),
				() => things.deleteEverythingFrom({ source: by }, context),
				() => things.removePerson({ person: ann }, context),
				() => things.removeGroup({ group }, context),
				() =>
					things.setTick(
						{ workspace: team, thing: team, party: { kind: "everyone" }, tick: "link", gives: true, source: by },
						context,
					),
				// A removal: its line cut, then its subtree cleared in background commits.
				async () => {
					await things.removeWorkspace({ workspace: team }, context);
					await eventually(
						() => database.prepare(`SELECT count(*) AS n FROM "${T}.removing"`).get()!.n,
						(n) => n === 0,
					);
				},
			]) {
				const plans = await plansOf(write);
				for (const step of plans.filter((each) => !/^(LIST SUBQUERY|SCAN json_each)/.test(each))) {
					assert.ok(/^SEARCH [tp] USING /.test(step) && !step.includes("TEMP B-TREE"), plans.join(" | "));
				}
			}
			// Of everything read since the start, only the pending deletes, removals, gone workspaces and sign-outs still to
			// end (few rows, read at the start and when the hooks change), and the persons and groups of the owner's picker
			// are read whole.
			const scans = [...ever].filter((sql) => plan(sql).some((step) => /^SCAN t( |$)/.test(step)));
			const whole = [
				`"${T}.pending"`,
				`"${T}.removing"`,
				`"${T}.gone"`,
				`"${T}.sign-outs"`,
				`"${T}.persons"`,
				`"${T}.groups"`,
			];
			assert.ok(
				scans.length > 0 && scans.every((sql) => whole.some((table) => sql.includes(table))),
				scans.join(" | "),
			);
		} finally {
			await host.close(context);
			await store.close(context);
		}
	});

	it("the cleanup of a share reads as much for 50 guests as for 5, in one commit (test 8)", async () => {
		const { database, runs } = recorded();
		const store = await openStore(sqliteBackend(new NodeSqliteDatabase(database)), context);
		const host = createHost<P3Principal>({
			address: Server(),
			principal: { kind: "server" },
			store,
			onError: (e) => assert.fail(e.kind),
		});
		try {
			await host.load([THINGS, RUNTIME, BOARD], context);
			const things = await host.get(ThingsStore, {}, context);
			const pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
			/** A share with `guests` guests in its group, put into Pi, removed: its reads, commits and statements. */
			const cleanup = async (guests: number) => {
				const share: Source = { kind: "thing", thing: `share-${guests}` };
				const managedBy = { kind: "thing", thing: share.thing } as const;
				const group = await things.makeGroup({ name: "guests", managedBy, outside: true }, context);
				await things.putParty({ workspace: pi, party: { kind: "group", group }, source: share }, context);
				for (let i = 0; i < guests; i++) {
					const person = await things.createPerson({ name: `guest ${i}`, madeBy: share }, context);
					await things.addToGroup({ group, person, source: share }, context);
				}
				const telemetry = new InMemoryTelemetryContext();
				const counted = (name: string) =>
					telemetry
						.getMetrics()
						.filter((metric) => metric.name === name)
						.reduce((sum, metric) => sum + metric.value, 0);
				const before = runs.count;
				await telemetry.startSpan({ name: "test.cleanup" }, (span) =>
					things.deleteEverythingFrom({ source: share }, withTelemetry(span, context)),
				);
				return {
					reads: runs.count - before,
					commits: counted("chord.store.commits"),
					statements: counted("chord.store.statements"),
				};
			};
			const few = await cleanup(5);
			const many = await cleanup(50);
			assert.equal(many.reads, few.reads, "reads per guest");
			assert.deepEqual([few.commits, many.commits], [1, 1]);
			// Four writes per guest that goes (their row, their sign-out, the switches and the links naming them), no read.
			assert.ok(many.statements - few.statements <= 45 * 4, `${few.statements} and ${many.statements} statements`);
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
