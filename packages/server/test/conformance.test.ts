import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeClientMessage, encodeFrame, PROTOCOL_VERSION } from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, test } from "vitest";
import { InternalServerError, NotImplementedError, type PiServer, PiServerError } from "../src/index.ts";
import { connectUnixTestClient, Deferred, type ProtocolTestClient, TestServerService } from "../src/testing/index.ts";
import { createUnixServer, type UnixServerOptions } from "../src/transports/unix/index.ts";

const servers = new Set<PiServer>();
const clients = new Set<ProtocolTestClient>();
const tempDirectories = new Set<string>();

async function startServer(
	service = new TestServerService(),
	overrides: Partial<UnixServerOptions> = {},
): Promise<{ server: PiServer; service: TestServerService }> {
	const directory = await mkdtemp(join(tmpdir(), "pis-"));
	tempDirectories.add(directory);
	const server = createUnixServer(service, {
		path: join(directory, "server.sock"),
		...overrides,
	});
	servers.add(server);
	await server.start();
	return { server, service };
}

async function connect(server: PiServer): Promise<ProtocolTestClient> {
	const client = await connectUnixTestClient(server.addresses[0]!);
	clients.add(client);
	return client;
}

afterEach(async () => {
	await Promise.all([...clients].map((client) => client.close()));
	clients.clear();
	await Promise.all([...servers].map((server) => server.close()));
	servers.clear();
	await Promise.all([...tempDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
	tempDirectories.clear();
});

describe("Unix transport conformance", () => {
	test("accepts a transport-fragmented framed-CBOR hello", async () => {
		const { server } = await startServer();
		const client = await connect(server);
		const response = client.next((message) => message.type === "hello");
		await client.sendFragmentedMessage({ type: "hello", version: PROTOCOL_VERSION }, 2);
		expect(await response).toMatchObject({ type: "hello", version: PROTOCOL_VERSION });
	});

	test("enforces version and exactly one first-message hello", async () => {
		const { server } = await startServer();

		const badVersion = await connect(server);
		expect(await badVersion.hello(PROTOCOL_VERSION + 1)).toMatchObject({
			type: "hello_error",
			error: { code: "version" },
		});
		await badVersion.waitForClose();

		const requestFirst = await connect(server);
		const firstError = requestFirst.next((message) => message.type === "hello_error");
		await requestFirst.sendMessage({ type: "request", id: "too-early", request: { command: "list" } });
		expect(await firstError).toMatchObject({ type: "hello_error", error: { code: "invalid_request" } });
		await requestFirst.waitForClose();

		const duplicate = await connect(server);
		expect(await duplicate.hello()).toMatchObject({ type: "hello" });
		const duplicateError = duplicate.next((message) => message.type === "hello_error");
		await duplicate.sendMessage({ type: "hello", version: PROTOCOL_VERSION });
		expect(await duplicateError).toMatchObject({ type: "hello_error", error: { code: "invalid_request" } });
		await duplicate.waitForClose();
	});

	test("closes connections that do not complete hello before the timeout", async () => {
		const { server } = await startServer(new TestServerService(), { handshakeTimeoutMs: 20 });
		const client = await connect(server);
		await client.waitForClose();
		expect(client.messages).toContainEqual(
			expect.objectContaining({ type: "hello_error", error: expect.objectContaining({ code: "invalid_request" }) }),
		);
	});

	test("keeps the handshake timeout active until the server hello is sent", async () => {
		const service = new TestServerService();
		const delay = service.delayNextList();
		const { server } = await startServer(service, { handshakeTimeoutMs: 20 });
		const client = await connect(server);
		await client.sendMessage({ type: "hello", version: PROTOCOL_VERSION });
		await delay.entered.promise;
		await client.waitForClose();
		delay.release.resolve(undefined);
		expect(client.messages).toContainEqual(
			expect.objectContaining({ type: "hello_error", error: expect.objectContaining({ code: "invalid_request" }) }),
		);
	});

	test("bounds and closes malformed or oversized frames", async () => {
		const malformedServer = await startServer();
		const malformed = await connect(malformedServer.server);
		const malformedError = malformed.next((message) => message.type === "hello_error");
		await malformed.sendBytes(encodeFrame(Uint8Array.of(0xff)));
		expect(await malformedError).toMatchObject({
			type: "hello_error",
			error: { code: "invalid_request" },
		});
		await malformed.waitForClose();

		const boundedServer = await startServer(new TestServerService(), { maxFrameLength: 128 });
		const oversized = await connect(boundedServer.server);
		const frame = new Uint8Array(4 + 129);
		frame[3] = 129;
		await oversized.sendBytes(frame);
		await oversized.waitForClose();
		expect(oversized.messages.some((message) => message.type === "hello")).toBe(false);

		const outboundServer = await startServer(new TestServerService(), { maxFrameLength: 128 });
		const outbound = await connect(outboundServer.server);
		await outbound.sendMessage({ type: "hello", version: PROTOCOL_VERSION });
		await outbound.waitForClose();
		expect(outbound.messages).toEqual([]);
	});

	test("catches up a handshaking client after a concurrent server change", async () => {
		class RacingService extends TestServerService {
			readonly entered = new Deferred<void>();
			readonly release = new Deferred<void>();
			race = false;

			override async listSessions() {
				const sessions = await super.listSessions();
				if (!this.race) return sessions;
				this.entered.resolve(undefined);
				await this.release.promise;
				return sessions;
			}
		}
		const service = new RacingService();
		service.seed("shared");
		const { server } = await startServer(service);
		const controller = await connect(server);
		await controller.hello();
		service.race = true;
		const joining = await connect(server);
		const hello = joining.hello();
		await service.entered.promise;
		await controller.request({ command: "attach", sessionId: "shared" });
		service.release.resolve(undefined);
		const handshake = await hello;
		if (handshake.type !== "hello") throw new Error("Expected server hello");
		const catchup = await joining.next(
			(message) =>
				message.type === "event" &&
				message.event.type === "server_snapshot" &&
				message.event.snapshot.revision > handshake.snapshot.revision,
		);
		expect(catchup).toMatchObject({
			type: "event",
			event: { type: "server_snapshot", snapshot: { sessions: [{ id: "shared", locked: true }] } },
		});
	});

	test("shares request, event, attachment, and disconnect behavior", async () => {
		const service = new TestServerService();
		service.seed("first");
		service.seed("second");
		const { server } = await startServer(service);
		const client = await connect(server);
		expect(await client.hello()).toMatchObject({
			type: "hello",
			snapshot: { sessions: [{ id: "first" }, { id: "second" }] },
		});

		const listed = await client.request({ command: "list" });
		expect(listed).toMatchObject({
			ok: true,
			result: { command: "list", sessions: [{ id: "first" }, { id: "second" }] },
		});
		expect(await client.request({ command: "attach", sessionId: "first" })).toMatchObject({
			ok: true,
			result: { command: "attach", session: { id: "first", attached: true } },
		});
		expect(await client.request({ command: "attach", sessionId: "second" })).toMatchObject({
			ok: true,
			result: { command: "attach", session: { id: "second", attached: true } },
		});

		const progress = {
			type: "assistant_delta" as const,
			messageId: "assistant-1",
			contentIndex: 0,
			kind: "text" as const,
			delta: "hello",
		};
		const progressEvent = client.next(
			(message) => message.type === "event" && message.event.type === "session_progress",
		);
		service.latestRuntime("first").emitProgress(progress);
		expect(await progressEvent).toEqual({
			type: "event",
			event: { type: "session_progress", sessionId: "first", progress },
		});

		expect(await client.request({ command: "detach", sessionId: "first" })).toMatchObject({
			ok: true,
			result: { command: "detach", sessionId: "first" },
		});
		expect(service.latestRuntime("first").disposeCount).toBe(1);
		expect(
			await client.request({ command: "set_thinking", sessionId: "second", thinkingLevel: "high" }),
		).toMatchObject({ ok: true, result: { session: { id: "second", thinkingLevel: "high" } } });

		const secondRuntime = service.latestRuntime("second");
		await client.close();
		await secondRuntime.disposed.promise;
		expect(secondRuntime.disposeCount).toBe(1);
	});

	test("disconnects attached clients when a runtime reports a terminal error", async () => {
		const service = new TestServerService();
		service.seed("terminal");
		const errors: Error[] = [];
		const { server } = await startServer(service, { onError: (error) => errors.push(error) });
		const client = await connect(server);
		await client.hello();
		await client.request({ command: "attach", sessionId: "terminal" });
		const runtime = service.latestRuntime("terminal");

		runtime.setPhase("turn");
		runtime.emitError(new PiServerError("session_locked", "lock ownership lost"));
		await client.waitForClose();
		await runtime.disposed.promise;
		expect(runtime.disposeCount).toBe(1);
		expect(service.locked.has("terminal")).toBe(false);
		expect(errors).toContainEqual(expect.objectContaining({ code: "session_locked" }));

		const nextClient = await connect(server);
		await nextClient.hello();
		expect(await nextClient.request({ command: "attach", sessionId: "terminal" })).toMatchObject({
			ok: true,
			result: { command: "attach", session: { id: "terminal" } },
		});
		expect(service.latestRuntime("terminal")).not.toBe(runtime);
	});

	test("does not expose unexpected service errors to clients", async () => {
		class FailingService extends TestServerService {
			private listCount = 0;

			override async listSessions() {
				this.listCount += 1;
				if (this.listCount > 1) throw new Error("private service detail");
				return super.listSessions();
			}
		}
		const errors: Error[] = [];
		const service = new FailingService();
		const { server } = await startServer(service, {
			onError: (error) => {
				errors.push(error);
				throw new Error("observer failure");
			},
		});
		const client = await connect(server);
		await client.hello();
		expect(await client.request({ command: "list" })).toMatchObject({
			ok: false,
			error: { code: "internal_error", message: "Internal server error" },
		});
		expect(errors).toContainEqual(expect.objectContaining({ message: "private service detail" }));
	});

	test("keeps not_implemented stable", async () => {
		class IncompleteService extends TestServerService {
			private listCount = 0;

			override async listSessions() {
				this.listCount += 1;
				if (this.listCount > 1) throw new NotImplementedError();
				return super.listSessions();
			}
		}
		const { server } = await startServer(new IncompleteService());
		const client = await connect(server);
		await client.hello();
		expect(await client.request({ command: "list" })).toMatchObject({
			ok: false,
			error: { code: "not_implemented", message: "Operation is not implemented" },
		});
	});

	test("reports wrapped internal causes without exposing them", async () => {
		const cause = new Error("private storage detail", { cause: new Error("private root cause") });
		class WrappedFailureService extends TestServerService {
			private listCount = 0;

			override async listSessions() {
				this.listCount += 1;
				if (this.listCount > 1) throw new InternalServerError(cause);
				return super.listSessions();
			}
		}
		const errors: Error[] = [];
		const { server } = await startServer(new WrappedFailureService(), { onError: (error) => errors.push(error) });
		const client = await connect(server);
		await client.hello();
		const response = await client.request({ command: "list" });
		expect(response).toMatchObject({
			ok: false,
			error: { code: "internal_error", message: "Internal server error" },
		});
		expect(JSON.stringify(response)).not.toContain("private");
		expect(errors).toContain(cause);
		expect(errors).not.toContainEqual(expect.objectContaining({ name: "InternalServerError" }));
	});

	test("can respond out of request order after the handshake", async () => {
		const service = new TestServerService();
		service.seed("first");
		const { server } = await startServer(service);
		const client = await connect(server);
		await client.hello();

		const delay = service.delayNextList();
		const slow = client.request({ command: "list" }, "slow");
		await delay.entered.promise;
		const fast = client.request({ command: "attach", sessionId: "first" }, "fast");
		expect(await fast).toMatchObject({ ok: true, id: "fast", result: { command: "attach" } });
		expect(client.messages.some((message) => message.type === "response" && message.id === "slow")).toBe(false);

		delay.release.resolve(undefined);
		expect(await slow).toMatchObject({ ok: true, id: "slow", result: { command: "list" } });
		const responseIds = client.messages
			.filter((message) => message.type === "response" && (message.id === "slow" || message.id === "fast"))
			.map((message) => (message.type === "response" ? message.id : ""));
		expect(responseIds).toEqual(["fast", "slow"]);
	});

	test("gracefully closes connections, sessions, and listener resources", async () => {
		const service = new TestServerService();
		service.seed("first");
		const { server } = await startServer(service);
		const socketPath = server.addresses[0];
		const client = await connect(server);
		await client.hello();
		await client.request({ command: "attach", sessionId: "first" });
		const runtime = service.latestRuntime("first");
		const clientClosed = client.waitForClose();

		await server.close();
		await clientClosed;
		expect(runtime.disposeCount).toBe(1);
		expect(server.addresses).toEqual([]);
		if (socketPath) await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
		await server.close();
	});
});

test("Unix socket decodes multiple framed requests from one raw chunk", async () => {
	const { server } = await startServer();
	const client = await connect(server);
	await client.hello();
	const first = encodeClientMessage({ type: "request", id: "first", request: { command: "list" } });
	const second = encodeClientMessage({ type: "request", id: "second", request: { command: "list" } });
	const combined = new Uint8Array(first.byteLength + second.byteLength);
	combined.set(first);
	combined.set(second, first.byteLength);
	const firstResponse = client.next((message) => message.type === "response" && message.id === "first");
	const secondResponse = client.next((message) => message.type === "response" && message.id === "second");
	await client.sendBytes(combined);
	expect(await firstResponse).toMatchObject({ type: "response", id: "first", ok: true });
	expect(await secondResponse).toMatchObject({ type: "response", id: "second", ok: true });
});
