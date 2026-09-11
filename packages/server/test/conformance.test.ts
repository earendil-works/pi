import type { ServiceCall } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, type SessionMetadata } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, test } from "vitest";
import type { ByteConnection, ByteConnectionHandler } from "../src/connection.ts";
import { SessionAmbiguousError } from "../src/errors.ts";
import { Server } from "../src/server.ts";
import {
	createTestServerServices,
	Deferred,
	ProtocolTestClient,
	TestServerHost,
	type WireChannel,
} from "../src/testing/index.ts";
import type { ServerHost } from "../src/types.ts";

const serverId = "00000000-0000-4000-8000-000000000001";
const servers = new Set<Server>();

function createServer(host: ServerHost, id = serverId): Server {
	const server = new Server(host, { listeners: [], serverId: id });
	servers.add(server);
	return server;
}

function connect(server: Server): ProtocolTestClient {
	let handler: ByteConnectionHandler;
	let client: ProtocolTestClient;
	let closed = false;
	const connection: ByteConnection = {
		get closed() {
			return closed;
		},
		async send(chunk) {
			client.receive(chunk);
		},
		close(finalChunk) {
			if (finalChunk) client.receive(finalChunk);
			closed = true;
			client.markClosed();
		},
	};
	const channel: WireChannel = {
		async send(chunk) {
			handler.onData(chunk);
		},
		async sendFragmented(chunk, splitAt) {
			handler.onData(chunk.subarray(0, splitAt));
			handler.onData(chunk.subarray(splitAt));
		},
		async close() {
			if (closed) return;
			closed = true;
			handler.onClose();
			client.markClosed();
		},
	};
	client = new ProtocolTestClient(channel);
	handler = server.accept(connection);
	return client;
}

function sessionCall(member: string, args: ServiceCall["args"] = []): ServiceCall {
	return { serviceId: "test.session", member, args };
}

function latestAttachmentId(client: ProtocolTestClient, sessionId: string): string {
	for (const message of [...client.messages].reverse()) {
		if (message.type === "attachment" && message.attachment?.sessionId === sessionId) {
			return message.attachment.attachmentId;
		}
	}
	throw new Error(`Missing attachment for ${sessionId}`);
}

afterEach(async () => {
	await Promise.all([...servers].map((server) => server.close()));
	servers.clear();
});

describe("Session protocol", () => {
	test("handshake identifies the logical server without listing sessions", async () => {
		const host = new TestServerHost();
		await host.seed();
		const client = connect(createServer(host));

		expect(await client.hello()).toMatchObject({ type: "hello", serverId });
		expect(host.harnesses.size).toBe(0);
	});

	test("rejects a semantically invalid service call after envelope decoding", async () => {
		const host = new TestServerHost();
		const client = connect(createServer(host));
		await client.hello();
		const response = client.next((message) => message.type === "response" && message.id === "invalid-call");
		await client.sendMessage({
			type: "request",
			id: "invalid-call",
			target: { serverId },
			call: { arbitrary: true },
		});
		expect(await response).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});

	test("attach passes concrete repository metadata to the Harness host", async () => {
		type BackendMetadata = SessionMetadata & { path: string; modifiedAt: number };
		const metadata: BackendMetadata = {
			id: "session-1",
			createdAt: 1,
			storageVersion: 1,
			cwd: "/workspace",
			path: "/sessions/session-1.jsonl",
			modifiedAt: 2,
		};
		let received: BackendMetadata | undefined;
		const host: ServerHost<BackendMetadata> = {
			serverServices: createTestServerServices(),
			resolveSession: async () => metadata,
			openSession: async (candidate) => {
				received = candidate;
				return {
					attachClient: () => ({ invokeService: async () => undefined, release() {} }),
					close: async () => {},
				};
			},
		};
		const client = connect(createServer(host));
		await client.hello();

		await expect(client.attach(serverId, "session-1")).resolves.toMatchObject({ ok: true });
		expect(received).toBe(metadata);
	});

	test("routes opaque server services and publishes attachment changes out of band", async () => {
		const backing = new TestServerHost();
		await backing.seed("session-1");
		let releaseCount = 0;
		const host: ServerHost = {
			resolveSession: (sessionId, context) => backing.resolveSession(sessionId, context),
			openSession: (metadata, context) => backing.openSession(metadata, context),
			serverServices: {
				attachClient(presentation) {
					return {
						async invokeService(call, _publish, context) {
							if (call.serviceId !== "pi.session-management") throw new Error("Unexpected service");
							if (call.member === "attach" && typeof call.args[0] === "string") {
								await presentation.attachSession(call.args[0], context);
								return null;
							}
							if (call.member === "detach") {
								await presentation.detachSession(context);
								return null;
							}
							throw new Error("Unexpected service member");
						},
						release() {
							releaseCount += 1;
						},
					};
				},
			},
		};
		const client = connect(createServer(host));
		await client.hello();
		const attached = client.next((message) => message.type === "attachment" && message.attachment !== null);
		await expect(client.attach(serverId, "session-1")).resolves.toMatchObject({ ok: true });
		await expect(attached).resolves.toMatchObject({
			type: "attachment",
			attachment: { sessionId: "session-1", attachmentId: expect.any(String) },
		});
		expect(backing.latestHarness("session-1").attachedClients).toBe(1);

		const detached = client.next((message) => message.type === "attachment" && message.attachment === null);
		await expect(
			client.requestService({ serverId }, { serviceId: "pi.session-management", member: "detach", args: [] }),
		).resolves.toMatchObject({ ok: true });
		await expect(detached).resolves.toMatchObject({ type: "attachment", attachment: null });
		expect(backing.latestHarness("session-1").attachedClients).toBe(0);
		await client.close();
		await expect.poll(() => releaseCount).toBe(1);
	});

	test("permits multiple client attachments per Session", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const server = createServer(host);
		const first = connect(server);
		const second = connect(server);
		await Promise.all([first.hello(), second.hello()]);

		await expect(first.attach(serverId, "session-1")).resolves.toMatchObject({ ok: true });
		await expect(first.attach(serverId, "session-1")).resolves.toMatchObject({ ok: true });
		expect(host.latestHarness("session-1").attachedClients).toBe(1);
		await expect(second.attach(serverId, "session-1")).resolves.toMatchObject({ ok: true });
		expect(host.harnesses.get("session-1")).toHaveLength(1);
		expect(host.latestHarness("session-1").attachedClients).toBe(2);

		await first.close();
		await expect.poll(() => host.latestHarness("session-1").attachedClients).toBe(1);
		await expect(second.attach(serverId, "session-1")).resolves.toMatchObject({ ok: true });
	});

	test("clears connection ownership when attachment release fails", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const errors: Error[] = [];
		const server = new Server(host, { listeners: [], serverId, onError: (error) => errors.push(error) });
		servers.add(server);
		const first = connect(server);
		const second = connect(server);
		await Promise.all([first.hello(), second.hello()]);
		await first.attach(serverId, "session-1");
		const harness = host.latestHarness("session-1");
		const releaseError = new Error("release failed");
		harness.failAttachmentRelease = releaseError;

		await first.close();
		await expect.poll(() => harness.attachmentReleaseCount).toBe(1);
		await expect.poll(() => errors).toContain(releaseError);
		harness.failAttachmentRelease = undefined;
		await expect(second.attach(serverId, "session-1")).resolves.toMatchObject({ ok: true });
	});

	test("requires the requesting client to hold the targeted Session attachment", async () => {
		const host = new TestServerHost();
		await Promise.all([host.seed("session-1"), host.seed("session-2")]);
		const server = createServer(host);
		const attached = connect(server);
		const unattached = connect(server);
		await Promise.all([attached.hello(), unattached.hello()]);

		await expect(unattached.requestSessionService(serverId, "session-1", sessionCall("run"))).resolves.toMatchObject({
			ok: false,
			error: { code: "session_not_attached" },
		});
		await attached.attach(serverId, "session-1");
		await expect(attached.requestSessionService(serverId, "session-2", sessionCall("run"))).resolves.toMatchObject({
			ok: false,
			error: { code: "session_not_attached" },
		});
		await expect(
			attached.requestSessionService(serverId, "session-1", sessionCall("run", ["Hello"])),
		).resolves.toMatchObject({ ok: true, result: { ok: true } });
		expect(host.latestHarness("session-1").serviceCalls).toEqual([sessionCall("run", ["Hello"])]);
	});

	test("rejects a stale attachment route after switching Sessions", async () => {
		const host = new TestServerHost();
		await Promise.all([host.seed("session-1"), host.seed("session-2")]);
		const client = connect(createServer(host));
		await client.hello();
		await client.attach(serverId, "session-1");
		const firstAttachmentId = latestAttachmentId(client, "session-1");
		await client.attach(serverId, "session-2");

		await expect(
			client.requestService(
				{ serverId, sessionId: "session-1", attachmentId: firstAttachmentId },
				sessionCall("run", ["stale"]),
			),
		).resolves.toMatchObject({ ok: false, error: { code: "session_not_attached" } });
		expect(host.latestHarness("session-1").serviceCalls).toEqual([]);
	});

	test("preserves opaque service results and bounds adapter defects", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const client = connect(createServer(host));
		await client.hello();
		await client.attach(serverId, "session-1");
		const harness = host.latestHarness("session-1");
		harness.nextServiceResult = { accepted: false, reason: "closed" };
		await expect(client.requestSessionService(serverId, "session-1", sessionCall("run"))).resolves.toMatchObject({
			ok: true,
			result: { accepted: false, reason: "closed" },
		});

		harness.nextServiceError = new Error("private adapter detail");
		await expect(client.requestSessionService(serverId, "session-1", sessionCall("run"))).resolves.toMatchObject({
			ok: false,
			error: { code: "internal_error", message: "Internal server error" },
		});
	});

	test("admits concurrent service calls to the attached Session", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const client = connect(createServer(host));
		await client.hello();
		await client.attach(serverId, "session-1");
		const harness = host.latestHarness("session-1");
		const gate = harness.gateNextServiceCall();
		const first = client.requestSessionService(serverId, "session-1", sessionCall("run", ["first"]));
		await gate.entered.promise;
		const second = client.requestSessionService(serverId, "session-1", sessionCall("run", ["second"]));

		await expect(second).resolves.toMatchObject({ ok: true });
		expect(harness.serviceCalls).toEqual([sessionCall("run", ["first"]), sessionCall("run", ["second"])]);
		gate.release.resolve(undefined);
		await expect(first).resolves.toMatchObject({ ok: true });
	});

	test("keeps attachment demand until an accepted service call settles after disconnect", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const client = connect(createServer(host));
		await client.hello();
		await client.attach(serverId, "session-1");
		const harness = host.latestHarness("session-1");
		const gate = harness.gateNextServiceCall();
		const calling = client.requestSessionService(serverId, "session-1", sessionCall("run"));
		const disconnectedCall = expect(calling).rejects.toThrow(/closed/i);
		await gate.entered.promise;

		await client.close();
		expect(harness.attachedClients).toBe(1);
		gate.release.resolve(undefined);
		await disconnectedCall;
		await expect.poll(() => harness.attachedClients).toBe(0);
	});

	test("rejects requests addressed to another server before repository access", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const client = connect(createServer(host));
		await client.hello();

		await expect(client.attach("00000000-0000-4000-8000-000000000002", "session-1")).resolves.toMatchObject({
			ok: false,
			error: { code: "wrong_server" },
		});
		expect(host.harnesses.size).toBe(0);
	});

	test("reports an unknown session without creating a Harness", async () => {
		const host = new TestServerHost();
		const client = connect(createServer(host));
		await client.hello();

		await expect(client.attach(serverId, "missing")).resolves.toMatchObject({
			ok: false,
			error: { code: "session_not_found" },
		});
		expect(host.harnesses.size).toBe(0);
	});

	test("rejects an ambiguous session ID without creating a Harness", async () => {
		type BackendMetadata = SessionMetadata & { path: string };
		const host: ServerHost<BackendMetadata> = {
			serverServices: createTestServerServices(),
			resolveSession: async () => {
				throw new SessionAmbiguousError();
			},
			openSession: async () => {
				throw new Error("must not create a Harness for an ambiguous session");
			},
		};
		const client = connect(createServer(host));
		await client.hello();

		await expect(client.attach(serverId, "duplicate")).resolves.toMatchObject({
			ok: false,
			error: { code: "session_ambiguous" },
		});
	});

	test("invalidates a terminated Harness handle and allows a later attach", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const client = connect(createServer(host));
		await client.hello();
		await client.attach(serverId, "session-1");
		const firstHarness = host.latestHarness("session-1");

		await firstHarness.terminate(new Error("worker crashed"));
		await firstHarness.terminated;
		await expect.poll(() => firstHarness.attachedClients).toBe(0);
		expect(firstHarness.attachmentReleaseCount).toBe(1);

		await expect(client.attach(serverId, "session-1")).resolves.toMatchObject({ ok: true });
		expect(host.harnesses.get("session-1")).toHaveLength(2);
	});

	test("connection loss releases its attachment, while server shutdown closes the Harness", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const server = createServer(host);
		const client = connect(server);
		await client.hello();
		await client.attach(serverId, "session-1");
		const harness = host.latestHarness("session-1");

		await client.close();
		await expect.poll(() => harness.attachedClients).toBe(0);
		expect(harness.closeCount).toBe(0);
		await server.close();
		expect(harness.closeCount).toBe(1);
	});
});

describe("routed Session acquisition failures", () => {
	test("releases a lease acquired concurrently with Harness termination", async () => {
		const metadata: SessionMetadata = { id: "session-1", createdAt: 1, storageVersion: 1 };
		const acquiring = new Deferred<void>();
		const continueAcquiring = new Deferred<void>();
		const terminated = new Deferred<Error | undefined>();
		let releaseCount = 0;
		const host: ServerHost = {
			serverServices: createTestServerServices(),
			resolveSession: async () => metadata,
			openSession: async () => ({
				terminated: terminated.promise,
				attachClient: async () => {
					acquiring.resolve(undefined);
					await continueAcquiring.promise;
					return {
						invokeService: async () => undefined,
						release: () => {
							releaseCount += 1;
						},
					};
				},
				close: async () => {},
			}),
		};
		const client = connect(createServer(host));
		await client.hello();
		const attach = client.attach(serverId, "session-1");
		await acquiring.promise;

		terminated.resolve(new Error("worker crashed"));
		continueAcquiring.resolve(undefined);
		await expect(attach).resolves.toMatchObject({ ok: false, error: { code: "server_draining" } });
		expect(releaseCount).toBe(1);
	});

	test("shares a Harness creation failure, releases the Session, and allows a later retry", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		host.nextOpenSessionError = new Error("Harness creation failed");
		const server = createServer(host);
		const first = connect(server);
		const second = connect(server);
		await Promise.all([first.hello(), second.hello()]);
		const gate = host.gateNextOpenSession();

		const firstAttach = first.attach(serverId, "session-1");
		await gate.entered.promise;
		const secondAttach = second.attach(serverId, "session-1");
		gate.release.resolve(undefined);

		await expect(Promise.all([firstAttach, secondAttach])).resolves.toMatchObject([
			{ ok: false, error: { code: "internal_error" } },
			{ ok: false, error: { code: "internal_error" } },
		]);
		expect(host.openSessionCount).toBe(1);

		await expect(first.attach(serverId, "session-1")).resolves.toMatchObject({ ok: true });
		expect(host.openSessionCount).toBe(2);
		expect(host.harnesses.get("session-1")).toHaveLength(1);
	});

	test("closes a Harness acquired while server shutdown is in progress", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const server = createServer(host);
		const client = connect(server);
		await client.hello();
		const gate = host.gateNextOpenSession();
		const attach = client.attach(serverId, "session-1");
		await gate.entered.promise;
		const closing = server.close();
		gate.release.resolve(undefined);

		await closing;
		await expect(attach).rejects.toThrow(/closed/i);
		expect(host.latestHarness("session-1").closeCount).toBe(1);
	});

	test("fails shutdown when an in-flight acquisition cannot release its Harness", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const cleanupError = new Error("close failed");
		host.nextHarnessCloseError = cleanupError;
		const server = createServer(host);
		const client = connect(server);
		await client.hello();
		const gate = host.gateNextOpenSession();
		const attach = client.attach(serverId, "session-1");
		await gate.entered.promise;

		const closing = server.close();
		gate.release.resolve(undefined);

		await expect(closing).rejects.toThrow(/Failed to close routed Sessions/);
		await expect(server.closed).rejects.toThrow(/Failed to close routed Sessions/);
		await expect(attach).rejects.toThrow(/closed/i);
		expect(host.latestHarness("session-1").closeCount).toBe(1);

		servers.delete(server);
		await host.latestHarness("session-1").close(BACKGROUND_CONTEXT);
	});
});
