// The plans of the sign-ins table's reads, as SQLite runs them: `rows.ofPerson` (its first page and the page after a
// bookmark), `rows.all`, and the read and the delete of `revokeOf` search the index their comments name, or the key,
// with no temporary B-tree; the start's whole-table read (every sign-in into memory) is the one scan. The test opens the plugin on a SQLite
// database of its own and records the statements Chord prepares.

import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, it } from "node:test";
import { createHttp } from "@earendil-works/chord/http";
import { NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import {
	BACKGROUND_CONTEXT as context,
	createHost,
	openStore,
	type P3Principal,
	Server,
	sqliteBackend,
} from "@earendil-works/p3/v1";
import { SignIns } from "../contract.ts";
import signInServer from "../server.ts";

/** One read (a page, a call), whose statements are recorded. */
type Read = () => Promise<unknown>;

describe("the plans of the sign-ins table's reads", () => {
	it("search their index or the key, and never sort", async () => {
		const database = new DatabaseSync(":memory:");
		const prepare = database.prepare.bind(database);
		const reads = new Set<string>();
		database.prepare = (sql) => {
			const statement = prepare(sql);
			const read = sql.startsWith("SELECT ") || sql.startsWith("DELETE ");
			if (!read || !sql.includes("sign-in.sign-ins")) return statement;
			const all = statement.all.bind(statement);
			const iterate = statement.iterate.bind(statement);
			const run = statement.run.bind(statement);
			// Chord passes positional parameters only.
			const listed = (...parameters: SQLInputValue[]) => {
				reads.add(sql);
				return all(...parameters);
			};
			const iterated = (...parameters: SQLInputValue[]) => {
				reads.add(sql);
				return iterate(...parameters);
			};
			const ran = (...parameters: SQLInputValue[]) => {
				reads.add(sql);
				return run(...parameters);
			};
			return Object.assign(statement, { all: listed, iterate: iterated, run: ran });
		};
		const store = await openStore(sqliteBackend(new NodeSqliteDatabase(database)), context);
		const host = createHost<P3Principal>({
			address: Server(),
			principal: { kind: "server" },
			store,
			onError: (error) => assert.fail(error.kind),
		});
		try {
			const http = createHttp(host, { onError: () => {} }, context);
			await host.load(
				[
					{ name: "chord.http", facet: http.facet },
					{ name: "@earendil-works/p3-sign-in", facet: signInServer },
				],
				context,
			);
			const signIns = await host.get(SignIns, {}, context);
			for (const id of ["ann", "ann", "ben"]) {
				const principal = { kind: "person", id, name: id } as const;
				await signIns.issue({ principal, label: "b", kind: "browser" }, context);
			}
			/** The steps of the plan of statement `sql`. */
			const plan = (sql: string) =>
				prepare(`EXPLAIN QUERY PLAN ${sql}`)
					.all(
						...sql
							.split("?")
							.slice(1)
							.map(() => "x"),
					)
					.map((step) => String(step.detail));
			/** The statements `read` ran, each with its plan's steps. */
			const plansOf = async (read: Read): Promise<(readonly [string, string[]])[]> => {
				reads.clear();
				await read();
				assert.ok(reads.size > 0);
				return [...reads].map((sql) => [sql, plan(sql)] as const);
			};
			/** A named query's first page and the page after it. */
			const pages = <A>(
				named: { page(args: A, n: number, ctx: typeof context, o?: { after: string }): Promise<{ next?: string }> },
				args: A,
			): Read[] => [
				() => named.page(args, 1, context),
				async () => {
					const first = await named.page(args, 1, context);
					return named.page(args, 1, context, { after: first.next! });
				},
			];
			const T = "sign-in.sign-ins";
			const cases: readonly (readonly [string, readonly Read[], string | undefined])[] = [
				["rows.ofPerson", pages(signIns.rows.ofPerson, { person: "ann" }), `${T}:by_person`],
				["rows.all", pages(signIns.rows.all, {}), undefined],
				["revokeOf", [() => signIns.revokeOf({ persons: ["ann", "ben"] }, context)], `${T}:by_person`],
			];
			for (const [name, read, index] of cases) {
				// One read after the other: each records its own statements.
				const statements: (readonly [string, string[]])[] = [];
				for (const each of read) statements.push(...(await plansOf(each)));
				const searched =
					index === undefined
						? /^(SEARCH|SCAN) t( |$)/
						: new RegExp(`USING (COVERING )?INDEX .*${index.replace(/\./g, "\\.")}`);
				for (const [sql, steps] of statements) {
					const shown = `${name}: ${sql}: ${steps.join(" | ")}`;
					assert.ok(
						steps.some((step) => searched.test(step)),
						shown,
					);
					assert.ok(!steps.some((step) => step.includes("TEMP B-TREE")), shown);
				}
				// `revokeOf`'s delete by person is one statement on the index too (Astra, quick look on round 1).
				if (name === "revokeOf") assert.ok(statements.some(([sql]) => sql.startsWith("DELETE ")));
			}
		} finally {
			await host.close(context);
			await store.close(context);
		}
	});
});
