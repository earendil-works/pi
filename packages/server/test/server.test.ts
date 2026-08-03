import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerMessageDecoder } from "@earendil-works/pi-protocol";
import { afterEach, expect, test, vi } from "vitest";
import type { ByteConnection } from "../src/connection.ts";
import { PiServer } from "../src/index.ts";
import { TestSessionBackend } from "../src/testing/index.ts";
import { createUnixServer } from "../src/transports/unix/index.ts";

const backend = new TestSessionBackend();

let server: PiServer | undefined;
let tempDirectory: string | undefined;

async function makeSocketPath(): Promise<string> {
	tempDirectory = await mkdtemp(join(tmpdir(), "pss-"));
	return join(tempDirectory, "server.sock");
}

afterEach(async () => {
	await server?.close();
	if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
	server = undefined;
	tempDirectory = undefined;
});

test("requires explicit listeners", () => {
	expect(() => Reflect.construct(PiServer, [backend, {}])).toThrow(/listeners/);
});

test("rejects Unix socket paths that cannot fit in sockaddr_un", () => {
	expect(() => createUnixServer(backend, { path: `/tmp/${"x".repeat(512)}` })).toThrow(/too long/);
});

test("rejects an overlong derived private Unix bind path", async () => {
	const maxLength = process.platform === "linux" ? 107 : 103;
	const suffixLength = Buffer.byteLength("/tmp//s");
	const path = `/tmp/${"x".repeat(maxLength - suffixLength)}/s`;
	server = createUnixServer(backend, { path });

	await expect(server.start()).rejects.toThrow(/private Unix bind path.*too long/);
});

test("rejects concurrent start calls without leaking the Unix listener", async () => {
	const path = await makeSocketPath();
	server = createUnixServer(backend, { path });
	const starting = server.start();
	await expect(server.start()).rejects.toThrow(/starting/);
	await starting;
	await server.close();
	expect(server.addresses[0]).toBeUndefined();
	await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("handshake timeout cleanup does not wait for a blocked output queue", async () => {
	class BlockedConnection implements ByteConnection {
		closed = false;
		finalChunk?: Uint8Array;

		send(): Promise<void> {
			return new Promise(() => {});
		}

		close(finalChunk?: Uint8Array): void {
			this.finalChunk = finalChunk;
			this.closed = true;
		}
	}
	const core = new PiServer(backend, {
		listeners: [],
		maxFrameLength: 1024,
		handshakeTimeoutMs: 10,
	});
	const connection = new BlockedConnection();
	core.accept(connection);

	await vi.waitFor(() => expect(connection.closed).toBe(true));
	expect(connection.finalChunk).toBeInstanceOf(Uint8Array);
	const messages = new ServerMessageDecoder().push(connection.finalChunk!);
	expect(messages).toMatchObject([{ type: "hello_error", error: { code: "invalid_request" } }]);
	await core.close();
});

test("rejects timeout values above Node's maximum timer delay", () => {
	const unix = { path: "/tmp/pi-server-timeout-test.sock" };
	expect(() => createUnixServer(backend, { path: unix.path, handshakeTimeoutMs: 2_147_483_648 })).toThrow(
		/handshakeTimeoutMs/,
	);
	expect(() => createUnixServer(backend, { path: unix.path, gracefulCloseTimeoutMs: 2_147_483_648 })).toThrow(
		/gracefulCloseTimeoutMs/,
	);
});

test("rejects pending-byte limits smaller than one maximum frame", async () => {
	const path = await makeSocketPath();
	expect(() => createUnixServer(backend, { path, maxFrameLength: 128, maxPendingBytes: 131 })).toThrow(
		/maxPendingBytes/,
	);
});
