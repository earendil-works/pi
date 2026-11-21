// The sessions plugin's server facet alone (`testPlugin`): the owner's `Sessions` creates, renames, archives and
// restores, and the owner's lists show it; persons and workers are refused both; `SessionFacts` gives a worker its own
// session's row; `SessionRoute` says whether a session exists.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, isChordError, type P3Principal } from "@earendil-works/p3/v1";
import { SessionRoute } from "@earendil-works/p3/v1/server";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { CODING, SessionFacts, Sessions, SessionsList } from "../contract.ts";

const OWNER: P3Principal = { kind: "owner" };

/** The coding app's active and archived lists, as one screen holds them. */
const ACTIVE = { app: CODING, set: "active", view: "test" } as const;
const ARCHIVED = { app: CODING, set: "archived", view: "test" } as const;

describe("the sessions plugin on the server", () => {
	let t: TestedPlugin<P3Principal>;
	beforeEach(async () => {
		t = await testPlugin(fileURLToPath(new URL("../", import.meta.url)), { kind: "server" }, context);
	});
	afterEach(() => t.close(context));

	it("creates, renames, archives and restores for the owner, and lists each step", async () => {
		await t.root(
			async (ctx) => {
				const sessions = await ctx.get(Sessions, {});
				const active = await ctx.get(SessionsList, ACTIVE);
				const before = Date.now();
				const id = await sessions.create({ title: "Plans" }, ctx);
				const [row] = active.list.value.rows;
				assert.deepEqual(row, {
					id,
					title: "Plans",
					app: CODING,
					creator: { kind: "owner" },
					createdAt: row!.createdAt,
					state: "settled",
					lastTouch: row!.createdAt,
					archivedAt: null,
				});
				assert.ok(row!.createdAt >= before);
				await sessions.rename({ id, title: "Better plans" }, ctx);
				assert.equal(active.list.value.rows[0]?.title, "Better plans");
				await sessions.archive({ id }, ctx);
				await sessions.restore({ id }, ctx);
				assert.deepEqual(active.list.value, { rows: [{ ...row, title: "Better plans" }], moreAfter: false });
			},
			context,
			{ principal: OWNER },
		);
		assert.deepEqual(t.unserved(), []);
	});

	it("moves an archived session to the archived list, and a restored one back", async () => {
		await t.root(
			async (ctx) => {
				const sessions = await ctx.get(Sessions, {});
				const active = await ctx.get(SessionsList, ACTIVE);
				const archived = await ctx.get(SessionsList, ARCHIVED);
				const kept = await sessions.create({ title: "Kept" }, ctx);
				const id = await sessions.create({ title: "Old" }, ctx);
				await sessions.archive({ id }, ctx);
				assert.deepEqual(
					active.list.value.rows.map((row) => row.id),
					[kept],
				);
				assert.deepEqual(
					archived.list.value.rows.map((row) => [row.id, typeof row.archivedAt]),
					[[id, "number"]],
				);
				// The last archived first, whatever was touched last.
				await new Promise((resolve) => setTimeout(resolve, 2));
				await sessions.archive({ id: kept }, ctx);
				assert.deepEqual(
					archived.list.value.rows.map((row) => row.id),
					[kept, id],
				);
				await sessions.restore({ id }, ctx);
				await sessions.restore({ id: kept }, ctx);
				assert.equal(active.list.value.rows.length, 2);
				assert.deepEqual(archived.list.value.rows, []);
			},
			context,
			{ principal: OWNER },
		);
	});

	it("lists an app's sessions only: another app's lists are empty", async () => {
		await t.root(
			async (ctx) => {
				const sessions = await ctx.get(Sessions, {});
				const id = await sessions.create({ title: "Coding" }, ctx);
				await sessions.archive({ id }, ctx);
				await sessions.create({ title: "Coding too" }, ctx);
				for (const set of ["active", "archived"] as const) {
					const other = await ctx.get(SessionsList, { app: "family", set, view: "test" });
					assert.deepEqual(other.list.value, { rows: [], moreAfter: false });
				}
			},
			context,
			{ principal: OWNER },
		);
	});

	it("refuses persons and workers the owner's sessions and lists", async () => {
		for (const principal of [
			{ kind: "person", id: "max", name: "Max" },
			{ kind: "worker", session: "s1" },
		] satisfies P3Principal[]) {
			await assert.rejects(
				t.root(async (ctx) => ctx.get(Sessions, {}), context, { principal }),
				(error) => isChordError(error, "forbidden"),
			);
			await assert.rejects(
				t.root(async (ctx) => ctx.get(SessionsList, ACTIVE), context, { principal }),
				(error) => isChordError(error, "forbidden"),
			);
		}
	});

	it("refuses the owner and persons a worker's facts", async () => {
		for (const principal of [OWNER, { kind: "person", id: "max", name: "Max" }] satisfies P3Principal[]) {
			await assert.rejects(
				t.root(async (ctx) => ctx.get(SessionFacts, {}), context, { principal }),
				(error) => isChordError(error, "forbidden"),
			);
		}
	});

	it("gives a worker its own session's row, and an unknown session none", async () => {
		const id = await t.root(async (ctx) => (await ctx.get(Sessions, {})).create({ title: "Mine" }, ctx), context, {
			principal: OWNER,
		});
		const mine = await t.root(async (ctx) => (await ctx.get(SessionFacts, {})).session.value, context, {
			principal: { kind: "worker", session: id },
		});
		assert.deepEqual([mine?.id, mine?.title], [id, "Mine"]);
		const none = await t.root(async (ctx) => (await ctx.get(SessionFacts, {})).session.value, context, {
			principal: { kind: "worker", session: "unknown" },
		});
		assert.equal(none, null);
	});

	it("tells the route whether a session exists", async () => {
		const id = await t.root(async (ctx) => (await ctx.get(Sessions, {})).create({}, ctx), context, {
			principal: OWNER,
		});
		const exists = (session: string) =>
			t.root(async (ctx) => (await ctx.get(SessionRoute, { session })).exists.value, context);
		assert.deepEqual([await exists(id), await exists("unknown")], [true, false]);
	});
});
