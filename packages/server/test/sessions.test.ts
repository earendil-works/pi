import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMetadata, SessionSnapshot, TranscriptProgress } from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, test } from "vitest";
import type { CreateSessionOptions, PiServer, PiSessionRuntime } from "../src/index.ts";
import {
	connectUnixTestClient,
	Deferred,
	type ProtocolTestClient,
	TEST_MODEL,
	TestServerService,
} from "../src/testing/index.ts";
import { createUnixServer, type UnixServerOptions } from "../src/transports/unix/index.ts";

const MODEL = TEST_MODEL;
type Client = ProtocolTestClient;
class MemoryService extends TestServerService {}

class OrderedSnapshotService extends MemoryService {
	readonly firstStarted = new Deferred<void>();
	readonly secondStarted = new Deferred<void>();
	readonly firstRelease = new Deferred<void>();
	readonly secondRelease = new Deferred<void>();
	controlled = false;
	startedCount = 0;

	override async listModels(): Promise<ModelMetadata[]> {
		if (!this.controlled) return super.listModels();
		this.startedCount += 1;
		if (this.startedCount === 1) {
			this.firstStarted.resolve(undefined);
			await this.firstRelease.promise;
		} else if (this.startedCount === 2) {
			this.secondStarted.resolve(undefined);
			await this.secondRelease.promise;
		}
		return [MODEL];
	}
}

const servers = new Set<PiServer>();
const clients = new Set<Client>();
const tempDirectories = new Set<string>();

async function startServer(service = new MemoryService(), options: Partial<UnixServerOptions> = {}) {
	const directory = await mkdtemp(join(tmpdir(), "pst-"));
	tempDirectories.add(directory);
	const server = createUnixServer(service, {
		path: join(directory, "server.sock"),
		...options,
	});
	servers.add(server);
	await server.start();
	return { server, service };
}

async function connect(server: PiServer): Promise<Client> {
	const client = await connectUnixTestClient(server.addresses[0]!);
	clients.add(client);
	return client;
}

async function attach(client: Client, sessionId: string): Promise<SessionSnapshot> {
	const response = await client.request({ command: "attach", sessionId });
	if (!response.ok || response.result.command !== "attach") throw new Error("Attach failed");
	return response.result.session;
}

afterEach(async () => {
	await Promise.all([...clients].map((client) => client.close()));
	clients.clear();
	await Promise.all([...servers].map((server) => server.close()));
	servers.clear();
	await Promise.all([...tempDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
	tempDirectories.clear();
});

describe("PiServer Unix integration", () => {
	test("serializes server snapshot revisions", async () => {
		const service = new OrderedSnapshotService();
		const { server } = await startServer(service);
		const client = await connect(server);
		await client.hello();
		service.controlled = true;
		const messageIndex = client.messages.length;

		const firstCreate = client.request({ command: "create", name: "first" });
		await service.firstStarted.promise;
		const secondCreate = client.request({ command: "create", name: "second" });
		await Promise.resolve();
		expect(service.startedCount).toBe(1);

		service.firstRelease.resolve(undefined);
		await service.secondStarted.promise;
		service.secondRelease.resolve(undefined);
		await Promise.all([firstCreate, secondCreate]);
		await client.nextFrom(
			messageIndex,
			(message) =>
				message.type === "event" &&
				message.event.type === "server_snapshot" &&
				message.event.snapshot.revision === 2,
		);

		const revisions = client.messages
			.slice(messageIndex)
			.flatMap((message) =>
				message.type === "event" && message.event.type === "server_snapshot"
					? [message.event.snapshot.revision]
					: [],
			);
		expect(revisions).toEqual([1, 2]);
	});

	test("creates server-assigned durable IDs and supports list, attach, and detach", async () => {
		const { server, service } = await startServer();
		const client = await connect(server);
		await client.hello();
		const created = await client.request({ command: "create", cwd: "/work", name: "Created" });
		expect(created.ok).toBe(true);
		if (!created.ok || created.result.command !== "create") throw new Error("Create failed");
		const createdId = created.result.session.id;
		expect(created.result.session).toMatchObject({
			id: service.lastCreatedId,
			cwd: "/work",
			name: "Created",
			attached: true,
			locked: true,
		});

		const listed = await client.request({ command: "list" });
		expect(listed).toMatchObject({
			ok: true,
			result: { command: "list", sessions: [{ id: service.lastCreatedId, attached: true, locked: true }] },
		});
		const detached = await client.request({ command: "detach", sessionId: createdId });
		expect(detached).toMatchObject({ ok: true, result: { command: "detach", sessionId: createdId } });
		expect(service.latestRuntime(createdId).disposeCount).toBe(1);
		const detachedAgain = await client.request({ command: "detach", sessionId: createdId });
		expect(detachedAgain).toMatchObject({ ok: true, result: { command: "detach", sessionId: createdId } });

		const attached = await attach(client, createdId);
		expect(attached.id).toBe(service.lastCreatedId);
		expect(service.runtimes.get(createdId)?.length).toBe(2);
	});

	test("keeps multiple attachments on one connection independent", async () => {
		const service = new MemoryService();
		service.seed("first");
		service.seed("second");
		const { server } = await startServer(service);
		const client = await connect(server);
		await client.hello();
		await attach(client, "first");
		await attach(client, "second");

		await client.request({ command: "detach", sessionId: "first" });
		expect(service.latestRuntime("first").disposeCount).toBe(1);
		expect(service.latestRuntime("second").disposeCount).toBe(0);
		const response = await client.request({
			command: "set_thinking",
			sessionId: "second",
			thinkingLevel: "medium",
		});
		expect(response).toMatchObject({ ok: true, result: { session: { id: "second", thinkingLevel: "medium" } } });
	});

	test("broadcasts full snapshots and progress only to clients attached to that session", async () => {
		const service = new MemoryService();
		service.seed();
		const { server } = await startServer(service);
		const attachedClient = await connect(server);
		const unattachedClient = await connect(server);
		await attachedClient.hello();
		await unattachedClient.hello();
		await attach(attachedClient, "session-1");
		const runtime = service.latestRuntime("session-1");
		const progress: TranscriptProgress = {
			type: "assistant_delta",
			messageId: "assistant-1",
			contentIndex: 0,
			kind: "text",
			delta: "hello",
		};
		runtime.emitProgress(progress);
		const progressMessage = await attachedClient.next(
			(message) => message.type === "event" && message.event.type === "session_progress",
		);
		expect(progressMessage).toEqual({
			type: "event",
			event: { type: "session_progress", sessionId: "session-1", progress },
		});
		expect(
			unattachedClient.messages.some(
				(message) => message.type === "event" && message.event.type === "session_progress",
			),
		).toBe(false);

		const messageCount = attachedClient.messages.length;
		runtime.emitSnapshot();
		const snapshotMessage = await attachedClient.nextFrom(
			messageCount,
			(message) =>
				message.type === "event" &&
				message.event.type === "session_snapshot" &&
				message.event.snapshot.revision === runtime.snapshot().revision,
		);
		expect(snapshotMessage).toMatchObject({
			type: "event",
			event: { type: "session_snapshot", snapshot: { id: "session-1", attached: true, locked: true } },
		});
		expect(
			unattachedClient.messages.some(
				(message) => message.type === "event" && message.event.type === "session_snapshot",
			),
		).toBe(false);
	});

	test("allows every attached client to control a singleton live runtime", async () => {
		const service = new MemoryService();
		service.seed();
		const { server } = await startServer(service);
		const first = await connect(server);
		const second = await connect(server);
		await first.hello();
		await second.hello();
		await attach(first, "session-1");
		const secondList = await second.request({ command: "list" });
		expect(secondList).toMatchObject({
			ok: true,
			result: { sessions: [{ id: "session-1", attached: false, locked: true }] },
		});
		await attach(second, "session-1");
		expect(service.runtimes.get("session-1")?.length).toBe(1);

		const modelResponse = await second.request({
			command: "set_model",
			sessionId: "session-1",
			model: { provider: "test", id: "large" },
		});
		expect(modelResponse).toMatchObject({ ok: true, result: { session: { model: { id: "large" } } } });
		await first.next(
			(message) =>
				message.type === "event" &&
				message.event.type === "session_snapshot" &&
				message.event.snapshot.model.id === "large",
		);
		const thinkingResponse = await first.request({
			command: "set_thinking",
			sessionId: "session-1",
			thinkingLevel: "high",
		});
		expect(thinkingResponse).toMatchObject({ ok: true, result: { session: { thinkingLevel: "high" } } });
	});

	test("does not queue prompts and processes steer and abort while a prompt response is pending", async () => {
		const service = new MemoryService();
		service.seed();
		const { server } = await startServer(service);
		const client = await connect(server);
		await client.hello();
		await attach(client, "session-1");

		const prompt = client.request({ command: "prompt", sessionId: "session-1", text: "first" });
		await client.next(
			(message) =>
				message.type === "event" &&
				message.event.type === "session_snapshot" &&
				message.event.snapshot.phase === "turn",
		);
		const busy = await client.request({ command: "prompt", sessionId: "session-1", text: "second" });
		expect(busy).toMatchObject({ ok: false, error: { code: "busy" } });

		const steer = await client.request({ command: "steer", sessionId: "session-1", text: "adjust" });
		expect(steer).toMatchObject({ ok: true, result: { command: "steer" } });
		expect(service.latestRuntime("session-1").steers).toEqual([{ text: "adjust" }]);
		const abort = await client.request({ command: "abort", sessionId: "session-1" });
		expect(abort).toMatchObject({ ok: true, result: { command: "abort" } });
		expect(await prompt).toMatchObject({ ok: true, result: { command: "prompt", session: { phase: "idle" } } });
	});

	test("returns operation attachment state relative to the requesting connection", async () => {
		const service = new MemoryService();
		service.seed();
		const { server } = await startServer(service);
		const first = await connect(server);
		const second = await connect(server);
		await first.hello();
		await second.hello();
		await attach(first, "session-1");
		await attach(second, "session-1");

		const prompt = first.request({ command: "prompt", sessionId: "session-1", text: "hello" });
		await first.next(
			(message) =>
				message.type === "event" &&
				message.event.type === "session_snapshot" &&
				message.event.snapshot.phase === "turn",
		);
		await first.request({ command: "detach", sessionId: "session-1" });
		service.latestRuntime("session-1").finishPrompt();

		expect(await prompt).toMatchObject({
			ok: true,
			result: { command: "prompt", session: { id: "session-1", attached: false } },
		});
	});

	test("keeps busy work alive after disconnect and disposes when it next becomes idle", async () => {
		const service = new MemoryService();
		service.seed();
		const { server } = await startServer(service);
		const client = await connect(server);
		await client.hello();
		await attach(client, "session-1");
		const prompt = client.request({ command: "prompt", sessionId: "session-1", text: "survive" });
		await client.next(
			(message) =>
				message.type === "event" &&
				message.event.type === "session_snapshot" &&
				message.event.snapshot.phase === "turn",
		);
		const runtime = service.latestRuntime("session-1");
		await client.close();
		await expect(prompt).rejects.toThrow(Error);
		expect(runtime.disposeCount).toBe(0);
		runtime.finishPrompt();
		await runtime.disposed.promise;
		expect(runtime.disposeCount).toBe(1);

		const reconnect = await connect(server);
		await reconnect.hello();
		const snapshot = await attach(reconnect, "session-1");
		expect(snapshot.transcript).toHaveLength(2);
		expect(snapshot.transcript[1]).toMatchObject({ role: "assistant", content: [{ text: "reply:survive" }] });
	});

	test("restores persisted sessions lazily after a server restart", async () => {
		const service = new MemoryService();
		service.seed();
		const { server: firstServer } = await startServer(service);
		const firstClient = await connect(firstServer);
		await firstClient.hello();
		await attach(firstClient, "session-1");
		await firstClient.request({ command: "set_thinking", sessionId: "session-1", thinkingLevel: "high" });
		await firstClient.close();
		await firstServer.close();

		const { server: secondServer } = await startServer(service);
		expect(service.runtimes.get("session-1")).toHaveLength(1);
		const secondClient = await connect(secondServer);
		await secondClient.hello();
		const restored = await attach(secondClient, "session-1");
		expect(restored.thinkingLevel).toBe("high");
		expect(service.runtimes.get("session-1")).toHaveLength(2);
	});

	test("rejects and disposes a service runtime with the wrong server-assigned ID", async () => {
		class WrongIdService extends MemoryService {
			override async createSession(options: CreateSessionOptions): Promise<PiSessionRuntime> {
				return super.createSession({ ...options, id: "wrong-id" });
			}
		}
		const service = new WrongIdService();
		const { server } = await startServer(service);
		const client = await connect(server);
		await client.hello();
		const response = await client.request({ command: "create" });
		expect(response).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(service.latestRuntime("wrong-id").disposeCount).toBe(1);
	});

	test("maps service lock errors and rejects control from unattached clients", async () => {
		const service = new MemoryService();
		service.seed("locked");
		service.locked.add("locked");
		const { server } = await startServer(service);
		const client = await connect(server);
		await client.hello();
		const locked = await client.request({ command: "attach", sessionId: "locked" });
		expect(locked).toMatchObject({ ok: false, error: { code: "session_locked" } });
		const unattached = await client.request({ command: "abort", sessionId: "locked" });
		expect(unattached).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});
});
