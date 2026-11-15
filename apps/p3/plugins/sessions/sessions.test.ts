// The sessions plugin's server facet alone (`testPlugin`): built as production builds it and loaded on a host of its
// own at the server's address. The owner's `Sessions` creates, renames, archives and restores; persons and workers are
// refused it; `SessionFacts` gives a worker its own session's facts, `null` for a session the server does not know.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { isChordError } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type TestedPlugin, testPlugin } from "@earendil-works/chord/plugins";
import { type P3Principal, Server } from "@p3/app/v1";
import { API } from "../../src/app.ts";
import { SessionFacts, Sessions } from "./contract.ts";

const OWNER: P3Principal = { kind: "owner" };

describe("the sessions plugin on the server", () => {
	let t: TestedPlugin<P3Principal>;
	beforeEach(async () => {
		t = await testPlugin<P3Principal>(
			fileURLToPath(new URL("./", import.meta.url)),
			{
				kind: "server",
				api: { name: API.name, versions: API.versions },
				modules: API.modules,
				principal: { kind: "server" },
				address: Server(),
			},
			context,
		);
	});
	afterEach(() => t.close(context));

	it("creates, renames, archives and restores for the owner", async () => {
		await t.root(
			async (ctx) => {
				const sessions = await ctx.get(Sessions, {});
				const id = await sessions.create({ title: "Plans" }, ctx);
				await sessions.rename({ id, title: "Better plans" }, ctx);
				await sessions.archive({ id }, ctx);
				const [archived] = sessions.list.value;
				assert.equal(archived?.title, "Better plans");
				assert.equal(typeof archived?.archivedAt, "number");
				await sessions.restore({ id }, ctx);
				assert.equal(sessions.list.value[0]?.archivedAt, null);
				assert.deepEqual(sessions.list.value[0]?.creator, { kind: "owner" });
			},
			context,
			{ principal: OWNER },
		);
		assert.deepEqual(t.unserved(), []);
	});

	it("refuses persons and workers the owner's sessions", async () => {
		for (const principal of [
			{ kind: "person", id: "max", name: "Max" },
			{ kind: "worker", session: "s1" },
		] satisfies P3Principal[]) {
			await assert.rejects(
				t.root(async (ctx) => ctx.get(Sessions, {}), context, { principal }),
				(error) => isChordError(error, "forbidden"),
			);
		}
	});

	it("gives a worker its own session's facts", async () => {
		const id = await t.root(async (ctx) => (await ctx.get(Sessions, {})).create({ title: "Mine" }, ctx), context, {
			principal: OWNER,
		});
		const facts = await t.root(async (ctx) => (await ctx.get(SessionFacts, {})).facts.value, context, {
			principal: { kind: "worker", session: id },
		});
		assert.equal(facts.session?.title, "Mine");
		const none = await t.root(async (ctx) => (await ctx.get(SessionFacts, {})).facts.value, context, {
			principal: { kind: "worker", session: "unknown" },
		});
		assert.equal(none.session, null);
	});
});
