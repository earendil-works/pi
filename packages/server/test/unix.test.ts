import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { Server } from "../src/index.ts";
import { connectUnixTestClient, type ProtocolTestClient, TestServerHost } from "../src/testing/index.ts";
import { createUnixServer, getUnixSocketPath } from "../src/transports/unix/index.ts";

const servers = new Set<Server>();
const clients = new Set<ProtocolTestClient>();
const children = new Set<ChildProcess>();
const tempDirectories = new Set<string>();

async function makeSocketPath(nested = false): Promise<string> {
	const directory = await mkdtemp(join("/tmp", "ps-"));
	tempDirectories.add(directory);
	return nested ? join(directory, "p", "n", "server.sock") : join(directory, "server.sock");
}

function makeServer(path: string): Server {
	const server = createUnixServer(new TestServerHost(), { path, serverId: "00000000-0000-4000-8000-000000000001" });
	servers.add(server);
	return server;
}

afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	await Promise.all([...children].map((child) => (child.exitCode === null ? once(child, "exit") : undefined)));
	children.clear();
	await Promise.all([...clients].map((client) => client.close()));
	clients.clear();
	await Promise.all([...servers].map((server) => server.close()));
	servers.clear();
	await Promise.all([...tempDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
	tempDirectories.clear();
});

test("creates an in-memory server ID and derives its explicit Unix socket path", async () => {
	const directory = await mkdtemp(join("/tmp", "pi-server-"));
	tempDirectories.add(directory);
	const serverId = "00000000-0000-4000-8000-000000000001";
	const path = getUnixSocketPath(serverId, directory);

	expect(path).toBe(join(directory, `${serverId}.sock`));
	const first = createUnixServer(new TestServerHost(), { serverId, path });
	servers.add(first);
	await first.start();
	const firstClient = await connectUnixTestClient(path);
	clients.add(firstClient);
	expect(await firstClient.hello()).toMatchObject({ serverId });
	await firstClient.close();
	clients.delete(firstClient);
	await first.close();
	servers.delete(first);

	const replacement = createUnixServer(new TestServerHost(), { serverId, path });
	servers.add(replacement);
	await replacement.start();
	const replacementClient = await connectUnixTestClient(path);
	clients.add(replacementClient);
	expect(await replacementClient.hello()).toMatchObject({ serverId });
});

describe("Unix listener filesystem lifecycle", () => {
	test("rejects a live listener without unlinking it", async () => {
		const path = await makeSocketPath();
		const first = makeServer(path);
		await first.start();
		const firstIdentity = await lstat(path);

		const second = makeServer(path);
		await expect(second.start()).rejects.toThrow(/already running/);
		const currentIdentity = await lstat(path);
		expect(currentIdentity.isSocket()).toBe(true);
		expect({ dev: currentIdentity.dev, ino: currentIdentity.ino }).toEqual({
			dev: firstIdentity.dev,
			ino: firstIdentity.ino,
		});

		const client = await connectUnixTestClient(path);
		clients.add(client);
		expect(await client.hello()).toMatchObject({ type: "hello" });
	});

	test("never unlinks a regular file at the configured path", async () => {
		const path = await makeSocketPath();
		await writeFile(path, "do not remove", { mode: 0o640 });
		const server = makeServer(path);
		await expect(server.start()).rejects.toThrow(/non-socket/);
		expect(await readFile(path, "utf8")).toBe("do not remove");
	});

	test("creates nested temp parents, restricts permissions, and removes its own socket", async () => {
		const path = await makeSocketPath(true);
		const server = makeServer(path);
		await server.start();
		const stats = await lstat(path);
		expect(stats.isSocket()).toBe(true);
		if (process.platform !== "win32") expect(stats.mode & 0o777).toBe(0o600);
		expect(await readdir(dirname(path))).toEqual(["server.sock"]);

		await server.close();
		await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("does not remove a replacement inode during shutdown", async () => {
		const path = await makeSocketPath();
		const server = makeServer(path);
		await server.start();
		await unlink(path);
		await writeFile(path, "replacement");

		const closing = server.close();
		expect(await readFile(path, "utf8")).toBe("replacement");
		await closing;
		expect(await readFile(path, "utf8")).toBe("replacement");
	});

	test("removes a genuinely stale socket before binding", async () => {
		const path = await makeSocketPath();
		const child = fork(new URL("fixtures/stale-socket-server.mjs", import.meta.url), [path], {
			stdio: ["ignore", "ignore", "inherit", "ipc"],
		});
		children.add(child);
		await once(child, "message");
		const staleIdentity = await lstat(path);
		expect(staleIdentity.isSocket()).toBe(true);
		child.kill("SIGKILL");
		await once(child, "exit");
		children.delete(child);

		const server = makeServer(path);
		await server.start();
		const liveIdentity = await lstat(path);
		expect(liveIdentity.isSocket()).toBe(true);
		const client = await connectUnixTestClient(path);
		clients.add(client);
		expect(await client.hello()).toMatchObject({ type: "hello" });
	});
});
