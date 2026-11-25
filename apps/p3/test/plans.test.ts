// The plans of the sessions store's named queries, as SQLite runs them: each read must walk its index in order, with
// no sort (a temporary B-tree would read and sort every row of a tie, or of the list, for one page). The test opens
// the server's store on a SQLite database of its own, records the statements Chord runs over the sessions table
// while each query reads its first page and the page after a bookmark, and asks SQLite for each one's plan.

import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, it } from "node:test";
import { createHost, openStore, sqliteBackend } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { type P3Principal, Server } from "@earendil-works/p3/v1";
import { SessionsStore } from "../plugins/sessions/contract.server.ts";
import { CODING } from "../plugins/sessions/contract.ts";
import sessionsServer from "../plugins/sessions/server.ts";

/** The sessions table in the store's database. */
const TABLE = "sessions.store:sessions.rows";

describe("the plans of the sessions store's queries", () => {
	it("walk their index in order: no query sorts", async () => {
		const database = new DatabaseSync(":memory:");
		const prepare = database.prepare.bind(database);
		/** The reads of the sessions table Chord ran, since the last reset. */
		const reads = new Set<string>();
		database.prepare = (sql) => {
			const statement = prepare(sql);
			if (!sql.startsWith("SELECT ") || !sql.includes(TABLE)) return statement;
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
		try {
			await host.load([{ name: "@earendil-works/p3-sessions", facet: sessionsServer }], context);
			const sessions = await host.get(SessionsStore, {}, context);
			for (let i = 0; i < 6; i++) {
				const id = await sessions.create({ title: `s${i}`, creator: { kind: "owner" } }, context);
				if (i % 2 === 0) await sessions.archive({ id }, context);
			}
			/** The plans of the statements `read` makes Chord prepare. */
			const plansOf = async (read: () => Promise<unknown>): Promise<string[]> => {
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
			for (const [name, index] of [
				["active", `${TABLE}:active`],
				["archived", `${TABLE}:archived`],
			] as const) {
				const query = sessions.sessions[name];
				const first = await query.page({ app: CODING }, 1, context);
				const plans = [
					...(await plansOf(() => query.page({ app: CODING }, 1, context))),
					...(await plansOf(() => query.page({ app: CODING }, 1, context, { after: first.next! }))),
				];
				assert.ok(plans.length >= 2, name);
				for (const step of plans) {
					assert.match(step, new RegExp(`^SEARCH t USING (COVERING )?INDEX ${index} `), `${name}: ${step}`);
				}
			}
			// The waker's read of every working session: the index `state`, never the whole table.
			const working = await plansOf(() => sessions.working({}, context));
			for (const step of working) {
				assert.match(step, new RegExp(`^SEARCH t USING (COVERING )?INDEX ${TABLE}:state `), `working: ${step}`);
			}
			const one = await plansOf(() => sessions.sessions.one.page({ id: "x" }, 1, context));
			assert.deepEqual(
				one.map((step) => /USING (INDEX|PRIMARY KEY)/.test(step) && !step.includes("TEMP B-TREE")),
				one.map(() => true),
			);
		} finally {
			await host.close(context);
			await store.close(context);
		}
	});
});
