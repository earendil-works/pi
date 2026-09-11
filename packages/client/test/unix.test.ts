import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { Server as RuntimeServer } from "../../server/src/server.ts";
import { createTestServerServices } from "../../server/src/testing/host.ts";
import { createUnixListener } from "../../server/src/transports/unix/listener.ts";
import { discoverUnixServers } from "../src/unix.ts";

const tempDirectories = new Set<string>();
const servers = new Set<RuntimeServer>();
const rawServers = new Set<Server>();
const rawSockets = new Set<Socket>();
const children = new Set<ChildProcess>();

async function makeDirectory(): Promise<string> {
	const directory = await mkdtemp(join("/tmp", "pc-"));
	tempDirectories.add(directory);
	return directory;
}

function serverId(value: number): string {
	return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

async function startServer(
	directory: string,
	fileServerId: string,
	reportedServerId = fileServerId,
): Promise<RuntimeServer> {
	const path = join(directory, `${fileServerId}.sock`);
	const server = new RuntimeServer(
		{
			serverServices: createTestServerServices(),
			resolveSession: async () => Promise.reject(new Error("unused")),
			openSession: async () => Promise.reject(new Error("unused")),
		},
		{ listeners: [createUnixListener({ path })], serverId: reportedServerId },
	);
	servers.add(server);
	await server.start();
	return server;
}

async function startSilentSocket(
	path: string,
	connections?: { active: number; maximum: number; total: number },
): Promise<void> {
	const server = createServer((socket) => {
		rawSockets.add(socket);
		if (connections) {
			connections.active += 1;
			connections.maximum = Math.max(connections.maximum, connections.active);
			connections.total += 1;
		}
		socket.once("close", () => {
			rawSockets.delete(socket);
			if (connections) connections.active -= 1;
		});
	});
	rawServers.add(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, resolve);
	});
}

afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	await Promise.all([...children].map((child) => (child.exitCode === null ? once(child, "exit") : undefined)));
	children.clear();
	await Promise.all([...servers].map((server) => server.close()));
	servers.clear();
	for (const socket of rawSockets) socket.destroy();
	rawSockets.clear();
	await Promise.all(
		[...rawServers].map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
				}),
		),
	);
	rawServers.clear();
	await Promise.all([...tempDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
	tempDirectories.clear();
});

describe("discoverUnixServers", () => {
	test("returns no routes when the server directory is missing", async () => {
		const directory = join(await makeDirectory(), "missing");
		await expect(discoverUnixServers({ directory })).resolves.toEqual([]);
	});

	test("discovers reachable servers in server ID order", async () => {
		const directory = await makeDirectory();
		const first = serverId(1);
		const second = serverId(2);
		await startServer(directory, second);
		await startServer(directory, first);

		await expect(discoverUnixServers({ directory })).resolves.toEqual([
			{ serverId: first, path: join(directory, `${first}.sock`) },
			{ serverId: second, path: join(directory, `${second}.sock`) },
		]);
	});

	test("ignores malformed entries, non-sockets, and mismatched servers", async () => {
		const directory = await makeDirectory();
		await writeFile(join(directory, `${serverId(1)}.sock`), "not a socket");
		await writeFile(join(directory, "not-a-server.sock"), "ignored");
		await mkdir(join(directory, `${serverId(2)}.sock`));
		await startServer(directory, serverId(3), serverId(4));

		await expect(discoverUnixServers({ directory })).resolves.toEqual([]);
	});

	test("ignores stale sockets without deleting them", async () => {
		const directory = await makeDirectory();
		const id = serverId(1);
		const path = join(directory, `${id}.sock`);
		const child = fork(new URL("fixtures/stale-socket-server.mjs", import.meta.url), [path], {
			stdio: ["ignore", "ignore", "inherit", "ipc"],
		});
		children.add(child);
		await once(child, "message");
		child.kill("SIGKILL");
		await once(child, "exit");
		children.delete(child);

		await expect(discoverUnixServers({ directory })).resolves.toEqual([]);
		expect((await lstat(path)).isSocket()).toBe(true);
	});

	test("times out an unresponsive socket without deleting it", async () => {
		const directory = await makeDirectory();
		const id = serverId(1);
		const path = join(directory, `${id}.sock`);
		await startSilentSocket(path);

		await expect(discoverUnixServers({ directory, timeoutMs: 20 })).resolves.toEqual([]);
		expect((await lstat(path)).isSocket()).toBe(true);
	});

	test("limits concurrent probes to 16", async () => {
		const directory = await makeDirectory();
		const connections = { active: 0, maximum: 0, total: 0 };
		for (let index = 1; index <= 20; index++) {
			await startSilentSocket(join(directory, `${serverId(index)}.sock`), connections);
		}

		const discovery = discoverUnixServers({ directory, timeoutMs: 100 });
		await expect.poll(() => connections.active).toBe(16);
		expect(connections.maximum).toBe(16);
		await expect(discovery).resolves.toEqual([]);
		expect(connections.total).toBe(20);
	});

	test("ignores an endpoint that closes before its handshake", async () => {
		const directory = await makeDirectory();
		const id = serverId(1);
		const path = join(directory, `${id}.sock`);
		const server = createServer((socket) => socket.destroy());
		rawServers.add(server);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(path, resolve);
		});

		await expect(discoverUnixServers({ directory })).resolves.toEqual([]);
	});

	test("propagates unexpected filesystem errors", async () => {
		const directory = await makeDirectory();
		const file = join(directory, "not-a-directory");
		await writeFile(file, "content");

		await expect(discoverUnixServers({ directory: file })).rejects.toMatchObject({ code: "ENOTDIR" });
	});
});
