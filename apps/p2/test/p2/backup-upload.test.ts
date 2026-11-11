// A slot's body streamed through the server (`StreamedUpload`, `plugins/backup/server.ts`): the remote reads the chunks
// as they arrive; a remote that answers without the body answers `begin` at once; an upload whose worker stops sending is
// dropped after its idle time, the remote's read failing so nothing is written.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { PutBatchResult, SyncBody } from "@p2/app/v1/node";
import { StreamedUpload } from "../../plugins/backup/server.ts";
import { isUrgentCommit } from "../../src/runtime/backup.ts";
import { INPUT_ENTRY } from "../../src/runtime/input.ts";

/** A remote that reads the whole body, then answers `created` with what it read. */
function reader(read: Uint8Array[]): (body: SyncBody) => Promise<PutBatchResult> {
	return async (body) => {
		for await (const chunk of body) read.push(chunk);
		return { type: "created" };
	};
}

test("streams the chunks to the remote in order, each taken before the next is sent", async () => {
	const read: Uint8Array[] = [];
	const upload = new StreamedUpload("server", reader(read));
	await upload.ready;
	assert.equal(upload.answered, false, "the remote asked for the body");
	for (const value of [1, 2, 3]) {
		await upload.push(new Uint8Array([value]));
		assert.equal(read.length, value, "the remote took the chunk before push resolved");
	}
	assert.deepEqual(await upload.end(), { type: "created" });
	assert.deepEqual(
		read.map((chunk) => chunk[0]),
		[1, 2, 3],
	);
});

test("a remote that answers without the body is ready at once, answered", async () => {
	const upload = new StreamedUpload("server", async () => {
		// As a remote whose slot is taken: it looks first, and never reads the body.
		await new Promise((resolve) => setTimeout(resolve, 20));
		return { type: "exists", to: 7, device: "other" };
	});
	await upload.ready;
	assert.equal(upload.answered, true);
	assert.deepEqual(await upload.result, { type: "exists", to: 7, device: "other" });
});

test("an upload whose worker stops sending is dropped: the remote's read fails", async () => {
	const read: Uint8Array[] = [];
	const upload = new StreamedUpload("server", reader(read));
	await upload.ready;
	let dropped = false;
	upload.watch(() => {
		dropped = true;
		upload.abort();
	}, 30);
	await upload.push(new Uint8Array([1]));
	// No more chunks: after the idle time the upload is dropped and the remote's read rejects. The idle timer is unref'd
	// (it never holds a stopping server open); a server keeps the process alive meanwhile, this timer does here.
	const alive = setInterval(() => {}, 10);
	try {
		await assert.rejects(upload.result, /aborted/);
	} finally {
		clearInterval(alive);
	}
	assert.equal(dropped, true);
	assert.equal(read.length, 1);
});

test("what a person sent is urgent on its own, before any answer", () => {
	const entry = (kind: string) => ({ seq: 1, changes: [{ type: "entry", value: { kind } }] }) as never;
	assert.equal(isUrgentCommit(entry(INPUT_ENTRY)), true, "p2's input");
	assert.equal(isUrgentCommit(entry("pi.assistant")), true, "an answer");
	assert.equal(isUrgentCommit(entry("p2.something-else")), false);
});
