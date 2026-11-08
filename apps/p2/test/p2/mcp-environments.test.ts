// The supervisor's pi-env connections (plugins/mcp/environments.ts): one per environment and configuration revision,
// shared by its users, closed with the last one; an edited environment is another connection. Connections here never
// start (a command that does not exist): a closed one refuses at once with "Connection closed", an open one tries to
// start and fails to spawn.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Connection } from "@earendil-works/pi-env";
import { type EnvConfig, envRevision } from "../../plugins/envs/config.ts";
import { EnvConnections } from "../../plugins/mcp/environments.ts";

const GPU: EnvConfig = { type: "ssh", host: "gpu.example" };
const EDITED: EnvConfig = { type: "ssh", host: "gpu.example", port: 2222 };

/** Whether `connection` was closed (it refuses at once) rather than open (it tries to start the daemon). */
const isClosed = async (connection: Connection): Promise<boolean> =>
	connection.info().then(
		() => false,
		(error: Error) => error.message === "Connection closed",
	);

test("users of one environment share its connection; the last release closes it", async () => {
	const opened: string[] = [];
	const envs = new EnvConnections((name) => {
		opened.push(name);
		return new Connection({ command: ["/nonexistent/pi-env"] });
	});
	const first = envs.acquire("gpu", GPU, envRevision(GPU));
	const second = envs.acquire("gpu", GPU, envRevision(GPU));
	assert.equal(second.connection, first.connection);
	const other = envs.acquire("box", GPU, envRevision(GPU));
	assert.notEqual(other.connection, first.connection);
	assert.deepEqual(opened, ["gpu", "box"]);
	first.release();
	assert.equal(await isClosed(second.connection), false);
	second.release();
	assert.equal(await isClosed(second.connection), true);
	assert.equal(await isClosed(other.connection), false);
	other.release();
	// A new user after the last one opens a new connection.
	const again = envs.acquire("gpu", GPU, envRevision(GPU));
	assert.notEqual(again.connection, first.connection);
	assert.deepEqual(opened, ["gpu", "box", "gpu"]);
	again.release();
});

test("an edited environment is another connection; the old one stays for its users until they release it", async () => {
	const envs = new EnvConnections(() => new Connection({ command: ["/nonexistent/pi-env"] }));
	const before = envs.acquire("gpu", GPU, envRevision(GPU));
	const after = envs.acquire("gpu", EDITED, envRevision(EDITED));
	assert.notEqual(after.connection, before.connection);
	before.release();
	assert.equal(await isClosed(before.connection), true);
	assert.equal(await isClosed(after.connection), false);
	after.release();
});
