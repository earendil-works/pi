// p2's host directories (per-host stores): the server's and each session's directory with its store and files, made
// private (0700, store 0600), every outbox off while p2 does not sync (also on a store that had one), the old layout
// refused.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@p2/app/v1";
import {
	assertMigrated,
	hostFiles,
	hostStore,
	openHostStore,
	serverDirectory,
	sessionDirectory,
} from "../../src/runtime/host-dirs.ts";

const temp = (t: { after: (fn: () => void) => void }) => {
	const dir = mkdtempSync(join(tmpdir(), "p2-host-dirs-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
};

test("lays out the server's and each session's directory, private, with the outbox off", async (t) => {
	const data = temp(t);
	assert.equal(serverDirectory(data), join(data, "server"));
	assert.equal(sessionDirectory(data, "a1b2"), join(data, "sessions", "a1b2"));
	assert.equal(hostFiles(sessionDirectory(data, "a1b2")), join(data, "sessions", "a1b2", "files"));
	for (const id of ["", "..", "a/b", "../x", ".hidden"]) assert.throws(() => sessionDirectory(data, id));
	const server = await openHostStore(serverDirectory(data), { outbox: false }, context);
	const session = await openHostStore(sessionDirectory(data, "s1"), { outbox: false }, context);
	assert.equal(server.outbox, undefined);
	assert.equal(session.outbox, undefined);
	await server.close(context);
	await session.close(context);
	const mode = (path: string) => statSync(path).mode & 0o777;
	assert.equal(mode(serverDirectory(data)), 0o700);
	assert.equal(mode(sessionDirectory(data, "s1")), 0o700);
	assert.equal(mode(hostStore(sessionDirectory(data, "s1"))), 0o600);
	assert.equal(mode(hostStore(serverDirectory(data))), 0o600);
});

test("refuses a data directory in the old layout", (t) => {
	const data = temp(t);
	assertMigrated(data);
	mkdirSync(join(data, "sessions", "s1"), { recursive: true });
	assertMigrated(data);
	writeFileSync(join(data, "sessions", "s2.sqlite"), "");
	assert.throws(() => assertMigrated(data), /migrate-data/);
	rmSync(join(data, "sessions", "s2.sqlite"));
	writeFileSync(join(data, "server.sqlite"), "");
	assert.throws(() => assertMigrated(data), /migrate-data/);
});

test("turns off the outbox of a store that had one", async (t) => {
	const data = temp(t);
	const before = await openHostStore(sessionDirectory(data, "s1"), { outbox: true }, context);
	assert.notEqual(before.outbox, undefined);
	await before.close(context);
	const after = await openHostStore(sessionDirectory(data, "s1"), { outbox: false }, context);
	assert.equal(after.outbox, undefined);
	await after.close(context);
});
