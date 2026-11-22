// The plans of the stores' named queries (sessions, people, environments, notes, canvas), as SQLite runs them: each read must search
// the index its comment names, with no sort (a temporary B-tree would read and sort every row of a tie, or of the list,
// for one page), except the joins ordered by a partner's column, which say in their comment that SQLite sorts their
// few rows: for those the plan asserted is the one they get. The test opens the server's store on a SQLite database of
// its own, records the statements Chord runs while each query reads its first page and the page after a bookmark, and
// asks SQLite for each one's plan.

import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, it } from "node:test";
import { createHost, openStore, sqliteBackend } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { type P3Principal, Server, THIS_DEVICE } from "@earendil-works/p3/v1";
import { EnvironmentsStore, PeopleStore, type ServerRuntime, SessionsStore } from "@earendil-works/p3/v1/server";
import appsServer from "../plugins/apps/server.ts";
import canvasServer from "../plugins/canvas/server.ts";
import { CanvasStore } from "../plugins/canvas/store.ts";
import codingServer from "../plugins/coding/server.ts";
import environmentsServer from "../plugins/environments/server.ts";
import notesServer from "../plugins/notes/server.ts";
import { NotesStore } from "../plugins/notes/store.ts";
import peopleServer from "../plugins/people/server.ts";
import sessionsServer from "../plugins/sessions/server.ts";
import { Notes, STUBS } from "../plugins/sessions/test/stubs.ts";
import { serverCoreFacet } from "../src/server.ts";

/** A query's pages, read once each. */
type Read = () => Promise<unknown>;

/**
 * What a query's plan must be: the index it searches (none: the table's key), and whether SQLite sorts (a join by a
 * partner's column).
 */
type Expected = { readonly index?: string; readonly sorts?: true };

describe("the plans of the stores' queries", () => {
	it("search their index in order: only the joins their comments name sort", async () => {
		const database = new DatabaseSync(":memory:");
		const prepare = database.prepare.bind(database);
		/** The reads Chord ran, since the last reset. */
		const reads = new Set<string>();
		database.prepare = (sql) => {
			const statement = prepare(sql);
			if (!sql.startsWith("SELECT ") || !sql.includes(".store:")) return statement;
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
		const onError = (error: { readonly kind: string }) => assert.fail(error.kind);
		const host = createHost<P3Principal>({ address: Server(), principal: { kind: "server" }, store, onError });
		const runtime = { dataDir: "/tmp", host, store } as unknown as ServerRuntime;
		try {
			await host.load(
				[
					{ name: "p3.server", facet: serverCoreFacet(runtime) },
					{ name: "@earendil-works/p3-apps", facet: appsServer },
					{ name: "@earendil-works/p3-canvas", facet: canvasServer },
					{ name: "@earendil-works/p3-coding", facet: codingServer },
					{ name: "@earendil-works/p3-environments", facet: environmentsServer },
					{ name: "@earendil-works/p3-notes", facet: notesServer },
					{ name: "@earendil-works/p3-people", facet: peopleServer },
					{ name: "@earendil-works/p3-sessions", facet: sessionsServer },
					STUBS.find(({ name }) => name === "p3-test-kind")!,
				],
				context,
			);
			const sessions = await host.get(SessionsStore, {}, context);
			const people = await host.get(PeopleStore, {}, context);
			const environments = await host.get(EnvironmentsStore, {}, context);
			const notes = await host.get(NotesStore, {}, context);
			for (const notebook of ["owner", "person:ann"]) {
				for (let i = 0; i < 3; i++) await notes.add({ notebook, text: `n${i}`, author: "owner" }, context);
			}
			const ann = await people.createPerson({ name: "Ann" }, context);
			await people.createPerson({ name: "Ben" }, context);
			const coaches = await people.group({ app: "coding", name: "coaches" }, context);
			await people.group({ app: "coding", name: "players" }, context);
			await people.addToGroup({ group: coaches, person: ann }, context);
			const members = [`person:${ann}`, `group:${coaches}`];
			let one = "";
			for (let i = 0; i < 6; i++) {
				one = await sessions.create(
					{
						app: "coding",
						title: `s${i}`,
						location: { environment: THIS_DEVICE, folder: "/tmp" },
						members: [
							{ kind: "person", id: ann, access: "read" },
							{ kind: "group", id: coaches, access: "write" },
						],
						things: [{ kind: Notes.name }, { kind: Notes.name }],
					},
					context,
				);
				if (i % 2 === 0) await sessions.archive({ session: one }, context);
			}
			const thing = (await sessions.things.of.page({ session: one }, 1, context)).items[0]!.thing;
			const canvas = await host.get(CanvasStore, {}, context);
			for (const board of ["b1", "b2"]) {
				const rect = { kind: "rect", color: "#000000", x: 0, y: 0, w: 10, h: 10, fill: false } as const;
				await canvas.add({ session: one, thing: board, shapes: [rect, rect, rect], author: "owner" }, context);
			}
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
			/** A named query's first page and the page after it, each read once. */
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
			const S = "sessions.store:sessions";
			const P = "people.store:people";
			const E = "environments.store:environments";
			const N = "notes.store:notes";
			const C = "canvas.store:canvas";
			const cases: readonly (readonly [string, readonly Read[], Expected])[] = [
				["sessions.active", pages(sessions.sessions.active, { app: "coding" }), { index: `${S}.rows:active` }],
				[
					"sessions.archived",
					pages(sessions.sessions.archived, { app: "coding" }),
					{ index: `${S}.rows:archived` },
				],
				["sessions.one", pages(sessions.sessions.one, { id: one }), {}],
				["members.of", pages(sessions.members.of, { session: one }), { index: `${S}.members:by_position` }],
				[
					"memberships.active",
					pages(sessions.memberships.active, { app: "coding", members }),
					{ index: `${S}.members:by_member`, sorts: true },
				],
				[
					"memberships.archived",
					pages(sessions.memberships.archived, { app: "coding", members }),
					{ index: `${S}.members:by_member`, sorts: true },
				],
				["things.of", pages(sessions.things.of, { session: one }), { sorts: true }],
				["things.one", pages(sessions.things.one, { session: one, thing }), {}],
				["options.of", pages(sessions.options.of, { session: one, thing }), {}],
				["options.ofSession", pages(sessions.options.ofSession, { session: one, for: "everyone" }), {}],
				["options.inSession", pages(sessions.options.inSession, { session: one }), {}],
				["working", [() => sessions.working({}, context)], { index: `${S}.rows:working` }],
				["persons.all", pages(people.persons.all, {}), { index: `${P}.persons:by_name` }],
				["persons.one", pages(people.persons.one, { id: ann }), {}],
				["persons.ofIds", pages(people.persons.ofIds, { ids: [ann, "none"] }), {}],
				["groups.ofApp", pages(people.groups.ofApp, { app: "coding" }), { index: `${P}.groups:of_app` }],
				["groups.one", pages(people.groups.one, { id: coaches }), {}],
				["groups.ofIds", pages(people.groups.ofIds, { ids: [coaches, "none"] }), {}],
				[
					"groups.ofPerson",
					pages(people.groups.ofPerson, { person: ann }),
					{ index: `${P}.group-members:of_person` },
				],
				["members.of (people)", pages(people.members.of, { group: coaches }), { sorts: true }],
				["environments.all", pages(environments.environments.all, {}), { index: `${E}.rows:by_name` }],
				["environments.one", pages(environments.environments.one, { id: THIS_DEVICE }), {}],
				["notes.of", pages(notes.notes.of, { notebook: "owner" }), { index: `${N}.rows:by_time` }],
				["shapes.of", pages(canvas.shapes.of, { session: one, thing: "b1" }), { index: `${C}.shapes:by_order` }],
			];
			for (const [name, read, expected] of cases) {
				const plans = (await Promise.all(read.map((each) => plansOf(each)))).flat();
				// A whole list (no condition) walks its index from the start: a scan of the index, never of the table.
				const searches = plans.filter((step) => /^(SEARCH|SCAN) t USING /.test(step));
				assert.ok(searches.length > 0, `${name}: ${plans.join(" | ")}`);
				const own = searches[0]!;
				const index =
					expected.index === undefined
						? /^SEARCH t USING PRIMARY KEY /
						: new RegExp(`^(SEARCH|SCAN) t USING (COVERING )?INDEX ${escaped(expected.index)}( |$)`);
				assert.match(own, index, `${name}: ${plans.join(" | ")}`);
				assert.equal(
					plans.some((step) => step.includes("TEMP B-TREE")),
					expected.sorts === true,
					`${name}: ${plans.join(" | ")}`,
				);
			}
			// A person leaving the Pi: their memberships by `by_member`, what they brought by `by_bringer`, each thing's
			// rows by its key; no read walks a table or sorts.
			const removal = await plansOf(() => sessions.removePerson({ person: ann }, context));
			const shown = removal.join(" | ");
			assert.ok(
				removal.some((step) => step.includes(`${S}.members:by_member`)),
				shown,
			);
			assert.ok(
				removal.some((step) => step.includes(`${S}.things:by_bringer`)),
				shown,
			);
			for (const step of removal) {
				assert.ok(/^SEARCH t USING /.test(step) && !step.includes("TEMP B-TREE"), `removePerson: ${shown}`);
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
