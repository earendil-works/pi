// Tests of the owner's stop over HTTP (`POST /_p3/stop`): the owner's only, answered before the stop runs.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { SignIns } from "../../src/kit/sign-ins.ts";
import { kitApp, send } from "./support.ts";

describe("the owner's stop", () => {
	it("is refused without a sign-in and to anyone but the owner, and runs nothing then", async () => {
		const stops: string[] = [];
		const { app, port } = await kitApp({ onStop: () => stops.push("stopped") });
		const ask = (headers: Record<string, string>) => send(port, "POST", "/_p3/stop", { headers });
		assert.equal((await ask({})).status, 401);
		const person = { principal: { kind: "person", id: "max", name: "Max" }, label: "Max", kind: "device" } as const;
		const max = await app.host.root(async (ctx) => (await ctx.get(SignIns, {})).issue(person, ctx), context);
		assert.equal((await ask({ authorization: `Bearer ${max.token}` })).status, 403);
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(stops, []);
	});

	it("answers the owner, then stops", async () => {
		const stops: string[] = [];
		const { app, port } = await kitApp({ onStop: () => stops.push("stopped") });
		const owner = (await readFile(app.ownerTokenFile, "utf8")).trim();
		const answer = await send(port, "POST", "/_p3/stop", { headers: { authorization: `Bearer ${owner}` } });
		assert.deepEqual([answer.status, JSON.parse(answer.body)], [200, "stopping"]);
		// The stop follows the answer (a launched server closes then: `commands.ts`, the stop over HTTP).
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(stops, ["stopped"]);
	});
});
