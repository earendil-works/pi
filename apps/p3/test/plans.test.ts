// The plans of the stores' named queries (sessions, people, notes, canvas, checklist, prompt, Files' staged uploads),
// as SQLite runs them: each read must search the index its comment names, with no sort (a temporary B-tree would read
// and sort every row of a tie, or of the list, for one page), except the joins ordered by a partner's column, which say
// in their comment that SQLite sorts their few rows: for those the plan asserted is the one they get. The test opens
// the server's store on a SQLite database of its own, records the statements Chord runs while each query reads its
// first page and the page after a bookmark, and asks SQLite for each one's plan.

import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, it } from "node:test";
import { createHost, openStore, sqliteBackend } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { defineFacet, type P3Principal, Server } from "@earendil-works/p3/v1";
import { OneThing, PeopleStore, type ServerRuntime, SessionsStore } from "@earendil-works/p3/v1/server";
import canvasServer from "../plugins/canvas/server.ts";
import { CanvasStore } from "../plugins/canvas/store.ts";
import checklistServer from "../plugins/checklist/server.ts";
import { ChecklistStore } from "../plugins/checklist/store.ts";
import { MACHINE_KIND } from "../plugins/environments/contract.ts";
import environmentsServer from "../plugins/environments/server.ts";
import { seeded } from "../plugins/environments/test/seeded.ts";
import { StagingStore, serveStaging } from "../plugins/files/staging.ts";
import notesServer from "../plugins/notes/server.ts";
import { NotesStore } from "../plugins/notes/store.ts";
import peopleServer from "../plugins/people/server.ts";
import { PromptStore, serveStore as servePrompt } from "../plugins/prompt/store.ts";
import { DefaultsSettings } from "../plugins/sessions/defaults.ts";
import sessionsServer from "../plugins/sessions/server.ts";
import thingsServer from "../plugins/things/server.ts";
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
			// The stores' tables, the session defaults' own (a local of the sessions plugin besides its store) and Files'
			// staged uploads' (a local of the files plugin besides its routes).
			if (!sql.startsWith("SELECT ") || !/\.store:|sessions\.defaults-settings:|files\.staging:/.test(sql)) {
				return statement;
			}
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
		const runtime = {
			dataDir: "/tmp",
			host,
			store,
			machine: { user: "owner", hostname: "test" },
		} as unknown as ServerRuntime;
		try {
			await host.load(
				[
					{ name: "p3.server", facet: serverCoreFacet(runtime) },
					{ name: "@earendil-works/p3-canvas", facet: canvasServer },
					{ name: "@earendil-works/p3-checklist", facet: checklistServer },
					{ name: "@earendil-works/p3-environments", facet: environmentsServer },
					{ name: "@earendil-works/p3-notes", facet: notesServer },
					{ name: "@earendil-works/p3-people", facet: peopleServer },
					{ name: "@earendil-works/p3-sessions", facet: sessionsServer },
					{ name: "@earendil-works/p3-things", facet: thingsServer },
					// The kinds' store alone: its kinds need the things plugin, whose store has a plan test of its own.
					{ name: "@earendil-works/p3-prompt", facet: defineFacet((h) => servePrompt(h)) },
					// Files' staged uploads alone: the files plugin's kind needs the things plugin's kinds loaded.
					{ name: "@earendil-works/p3-files", facet: defineFacet((h) => serveStaging(h)) },
				],
				context,
			);
			const sessions = await host.get(SessionsStore, {}, context);
			const people = await host.get(PeopleStore, {}, context);
			const machine = await seeded(await host.get(OneThing, { kind: MACHINE_KIND }, context), context);
			const notes = await host.get(NotesStore, {}, context);
			// Notebooks are things' ids: three notebooks of three notes each.
			const notebooks = ["n1", "n2", "n3"];
			for (const notebook of notebooks) {
				for (let i = 0; i < 3; i++)
					await notes.add({ notebook, text: `n${i}`, author: { kind: "person", person: "owner" } }, context);
			}
			await notes.configure({ notebook: "n1", order: "oldest" }, context);
			const checklists = await host.get(ChecklistStore, {}, context);
			for (const checklist of ["c1", "c2"]) {
				for (let i = 0; i < 3; i++) await checklists.add({ checklist, text: `i${i}` }, context);
			}
			const ann = await people.createPerson({ name: "Ann" }, context);
			await people.createPerson({ name: "Ben" }, context);
			const coaches = await people.group({ app: "coding", name: "coaches" }, context);
			await people.group({ app: "coding", name: "players" }, context);
			await people.addToGroup({ group: coaches, person: ann }, context);
			// Sessions' rows as the session kind's create hook writes them (their workspaces are the things store's,
			// which has a plan test of its own), half of them archived; and a defaults thing's settings.
			let one = "";
			for (let i = 0; i < 6; i++) {
				one = `s${i}`;
				await sessions.insert({ id: one, location: { machine, folder: "/tmp" }, model: null }, context);
				if (i % 2 === 0) await sessions.archive({ session: one }, context);
			}
			const settings = await host.get(DefaultsSettings, {}, context);
			await settings.set({ thing: "d1", defaults: { model: null, shared: false, opensWith: null } }, context);
			const canvas = await host.get(CanvasStore, {}, context);
			for (const board of ["b1", "b2"]) {
				const rect = { kind: "rect", color: "#000000", x: 0, y: 0, w: 10, h: 10, fill: false } as const;
				await canvas.add(
					{ canvas: board, shapes: [rect, rect, rect], author: { kind: "person", person: "owner" } },
					context,
				);
			}
			const prompt = await host.get(PromptStore, {}, context);
			for (const thing of ["t1", "t2"]) {
				await prompt.configureInstructions({ thing, text: "be kind", language: "en" }, context);
				await prompt.configureSkills({ thing, folder: thing }, context);
			}
			// Staged uploads on two machines, made at 1..3 each: an earlier process's are those before a bound.
			const staging = await host.get(StagingStore, {}, context);
			for (const machine of ["m1", "m2"]) {
				for (let at = 1; at <= 3; at++) {
					await staging.remember({ machine, path: `/tmp/${at}`, identity: `${at}`, at }, context);
				}
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
			const N = "notes.store:notes";
			const C = "canvas.store:canvas";
			const K = "checklist.store:checklist";
			const cases: readonly (readonly [string, readonly Read[], Expected])[] = [
				["sessions.one", pages(sessions.sessions.one, { id: one }), {}],
				["settings.of", pages(settings.settings.of, { thing: "d1" }), {}],
				["working", [() => sessions.working({}, context)], { index: `${S}.sessions:working` }],
				["persons.owner", pages(people.persons.owner, {}), { index: `${P}.persons:by_owner` }],
				["groups.ofApp", pages(people.groups.ofApp, { app: "coding" }), { index: `${P}.groups:of_app` }],
				["groups.one", pages(people.groups.one, { id: coaches }), {}],
				["groups.ofIds", pages(people.groups.ofIds, { ids: [coaches, "none"] }), {}],
				[
					"groups.ofPerson",
					pages(people.groups.ofPerson, { person: ann }),
					{ index: `${P}.group-members:of_person` },
				],
				["members.of (people)", pages(people.members.of, { group: coaches }), { sorts: true }],
				["notes.of", pages(notes.notes.of, { notebook: "n1", order: "newest" }), { index: `${N}.rows:by_time` }],
				[
					"notes.of (oldest first)",
					pages(notes.notes.of, { notebook: "n1", order: "oldest" }),
					{ index: `${N}.rows:by_time` },
				],
				["settings.of", pages(notes.settings.of, { notebook: "n1" }), {}],
				["shapes.of", pages(canvas.shapes.of, { canvas: "b1" }), { index: `${C}.shapes:by_order` }],
				["items.of", pages(checklists.items.of, { checklist: "c1" }), { index: `${K}.items:by_order` }],
				["prompt.instructions.of", pages(prompt.instructions.of, { thing: "t1" }), {}],
				["prompt.skills.of", pages(prompt.skills.of, { thing: "t1" }), {}],
				[
					"staging.stale",
					[() => staging.stale({ machine: "m1", before: 3 }, context)],
					{ index: "files.staging:files.staging:by_machine" },
				],
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
