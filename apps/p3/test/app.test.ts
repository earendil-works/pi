// p3 end to end: the real server (`startP3`: the kit's HTTP, sign-ins, plugin builds, a forked worker per session) on a
// temporary data directory, and a client over WebSocket signed in with the owner token file. The owner creates a
// session, its worker answers, and a restart on the same directory keeps it.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Sessions, SessionWorker } from "../plugins/sessions/contract.ts";
import { startP3 } from "../server.ts";
import { ownerClient } from "./client.ts";

describe("p3 end to end", () => {
	let dir: string;
	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "p3-app-"));
	});
	after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("creates a session whose forked worker answers, and keeps it across a restart", async () => {
		const dataDir = join(dir, "data");
		const first = await startP3(context, { dataDir, port: 0 });
		let id: string;
		try {
			const client = await ownerClient(first, context);
			const sessions = await client.get(Sessions, {}, context);
			id = await sessions.create({ title: "End to end" }, context);
			const worker = await client.get(SessionWorker, { session: id }, context);
			assert.equal(worker.facts.value.session?.title, "End to end");
			await client.close(context);
		} finally {
			await first.close(context);
		}
		const second = await startP3(context, { dataDir, port: 0 });
		try {
			const client = await ownerClient(second, context);
			const sessions = await client.get(Sessions, {}, context);
			assert.deepEqual(
				sessions.list.value.map((row) => [row.id, row.title]),
				[[id, "End to end"]],
			);
			await client.close(context);
		} finally {
			await second.close(context);
		}
	});
});
