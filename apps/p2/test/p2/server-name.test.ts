// The server's name: the owner's, kept in identity.json only while it is set, else the device's (src/runtime/server-name*.ts).
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { startServer } from "../../src/hosts/server.ts";
import { processLogs } from "../../src/runtime/logs.ts";
import { ServerNameSettings } from "../../src/runtime/server-name.ts";
import {
	deviceName,
	normalizeServerName,
	readChosenServerName,
	writeChosenServerName,
} from "../../src/runtime/server-name-file.ts";
import { clientHost, holdIn, localOwner, until } from "./helpers.ts";

async function dataDir(t: TestContext): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "p2-server-name-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

const exists = (path: string) =>
	access(path).then(
		() => true,
		() => false,
	);

test("Server names are one line of at most 63 characters", async () => {
	assert.equal(normalizeServerName("  Cristina's\u0000  MacBook\nPro "), "Cristina's MacBook Pro");
	assert.equal(normalizeServerName("x".repeat(80)), "x".repeat(63));
	assert.equal(normalizeServerName(" \t "), undefined);
	const device = await deviceName();
	if (device !== undefined) assert.equal(normalizeServerName(device), device);
});

test("identity.json holds the owner's name only while there is one; a broken file says why", async (t) => {
	const directory = await dataDir(t);
	const path = join(directory, "identity.json");
	assert.equal(await readChosenServerName(directory), undefined);
	await writeChosenServerName(directory, "Studio");
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { name: "Studio" });
	assert.equal(await readChosenServerName(directory), "Studio");
	await writeChosenServerName(directory, undefined);
	assert.equal(await exists(path), false);
	assert.equal(await readChosenServerName(directory), undefined);
	// Removing a name that is not there is no error.
	await writeChosenServerName(directory, undefined);
	for (const content of ["{ not json", "null", "[]", '{ "name": "  " }', '{ "name": 42 }']) {
		await writeFile(path, content);
		await assert.rejects(readChosenServerName(directory));
	}
});

test("The owner renames the server and back to the device's name, saved across restarts", async (t) => {
	const directory = await dataDir(t);
	const device = (await deviceName()) ?? null;
	const start = () => startServer({ dataDir: directory, port: 0, fake: true, web: false });
	let server = await start();
	t.after(() => server.close());
	const settings = async () => holdIn(clientHost(await localOwner(server)), ServerNameSettings, {}, "owner");
	let names = await settings();
	await until(names.name, (name) => name === device);
	assert.equal(names.chosen.value, null);
	assert.equal(names.device.value, device);
	assert.equal(await exists(join(directory, "identity.json")), false);

	await names.rename({ name: "  Studio\tbrain " }, BACKGROUND_CONTEXT);
	assert.equal(names.name.value, "Studio brain");
	assert.equal(names.chosen.value, "Studio brain");
	assert.deepEqual(JSON.parse(await readFile(join(directory, "identity.json"), "utf8")), { name: "Studio brain" });

	await server.close();
	server = await start();
	names = await settings();
	await until(names.name, (name) => name === "Studio brain");

	// Nothing left of a name is no name: the device's stands again, and the file is gone.
	await names.rename({ name: " \n " }, BACKGROUND_CONTEXT);
	assert.equal(names.name.value, device);
	assert.equal(names.chosen.value, null);
	assert.equal(await exists(join(directory, "identity.json")), false);
	await names.rename({ name: "Lab" }, BACKGROUND_CONTEXT);
	await names.rename({ name: null }, BACKGROUND_CONTEXT);
	assert.equal(names.name.value, device);
});

test("A broken identity.json does not keep the server from starting: it goes by the device's name", async (t) => {
	const directory = await dataDir(t);
	await writeFile(join(directory, "identity.json"), "{ not json");
	const server = await startServer({ dataDir: directory, port: 0, fake: true, web: false });
	t.after(() => server.close());
	const names = await holdIn(clientHost(await localOwner(server)), ServerNameSettings, {}, "owner");
	const device = (await deviceName()) ?? null;
	await until(names.name, (name) => name === device);
	assert.ok(processLogs.notices().some((notice) => /identity\.json is not usable/.test(notice.message)));
	// A rename replaces the file.
	await names.rename({ name: "Studio" }, BACKGROUND_CONTEXT);
	assert.deepEqual(JSON.parse(await readFile(join(directory, "identity.json"), "utf8")), { name: "Studio" });
});
