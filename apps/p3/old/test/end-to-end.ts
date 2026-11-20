// p3 end to end, whichever way it runs: in this process from source (`app.test.ts`), launched from source
// (`launched.test.ts`) or launched from an installed release (`release.test.ts`). A client over WebSocket signs in
// with the owner token file; the owner creates a session, its forked worker answers, a session that does not exist
// starts none, and a restart on the same directory keeps what was created.

import assert from "node:assert/strict";
import { isChordError } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { CODING, Sessions, SessionsList, SessionWorker } from "../plugins/sessions/contract.ts";
import { ownerClient, type Reachable } from "./client.ts";

/** A running p3 as the case drives it. */
export type Started = Reachable & {
	/** How many session workers run. */
	workers(): Promise<number>;
	close(): Promise<void>;
};

/** The coding app's active list, as one screen holds it. */
const ACTIVE = { app: CODING, set: "active", view: "test" } as const;

/** Runs the case against servers `start` makes on `dataDir`, one after the other. */
export async function endToEnd(start: (dataDir: string) => Promise<Started>, dataDir: string): Promise<void> {
	const first = await start(dataDir);
	let id: string;
	try {
		const client = await ownerClient(first, context);
		const sessions = await client.get(Sessions, {}, context);
		id = await sessions.create({ title: "End to end" }, context);
		const worker = await client.get(SessionWorker, { session: id }, context);
		assert.deepEqual([worker.session.value?.id, worker.session.value?.title], [id, "End to end"]);
		await assert.rejects(client.get(SessionWorker, { session: "unknown" }, context), (error) =>
			isChordError(error, "forbidden"),
		);
		assert.equal(await first.workers(), 1);
		await client.close(context);
	} finally {
		await first.close();
	}
	const second = await start(dataDir);
	try {
		const client = await ownerClient(second, context);
		const active = await client.get(SessionsList, ACTIVE, context);
		assert.deepEqual(
			active.list.value.rows.map((row) => [row.id, row.title]),
			[[id, "End to end"]],
		);
		await client.close(context);
	} finally {
		await second.close();
	}
}
