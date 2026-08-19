import { describe, expect, test } from "vitest";
import { collectRequests, connectClient, MemoryServer, openRemoteSession, sessionSnapshot } from "./support.ts";

describe("RemoteSession operations", () => {
	test("projects progress for subscribers without changing the authoritative snapshot", async () => {
		const server = new MemoryServer();
		const remoteSession = await openRemoteSession(
			await connectClient(server),
			server,
			sessionSnapshot("session-1", {
				phase: "turn",
				transcript: [
					{
						id: "assistant-1",
						role: "assistant",
						content: [{ type: "text", text: "hello" }],
						status: "streaming",
						model: { provider: "faux", id: "model" },
						timestamp: 1,
					},
				],
			}),
		);
		const views: string[] = [];
		remoteSession.subscribe((state) => {
			const item = state.transcript[0];
			if (item?.role === "assistant" && item.content[0]?.type === "text") views.push(item.content[0].text);
		});

		server.send({
			type: "event",
			event: {
				type: "session_progress",
				sessionId: "session-1",
				progress: {
					type: "assistant_delta",
					messageId: "assistant-1",
					contentIndex: 0,
					kind: "text",
					delta: " world",
				},
			},
		});

		expect(views).toEqual(["hello", "hello world"]);
		expect(remoteSession.snapshot?.transcript[0]).toMatchObject({ content: [{ text: "hello" }] });
	});

	test("becomes unbound and can reopen after its session is removed", async () => {
		const server = new MemoryServer();
		const client = await connectClient(server);
		const remoteSession = await openRemoteSession(client, server, sessionSnapshot("session-1"));

		server.send({ type: "event", event: { type: "session_removed", sessionId: "session-1" } });

		expect(remoteSession.id).toBeUndefined();
		expect(remoteSession.snapshot).toBeUndefined();
		expect(remoteSession.state.transcript).toEqual([]);
		expect(remoteSession.state.lifecycle).toEqual({ status: "unbound" });

		const requests = collectRequests(server);
		const reopening = remoteSession.open("session-1");
		const request = requests.at(-1);
		expect(request?.request).toEqual({ command: "attach", sessionId: "session-1" });
		if (!request) throw new Error("Missing attach request");
		server.send({
			type: "response",
			id: request.id,
			ok: true,
			result: { command: "attach", session: sessionSnapshot("session-1", { revision: 2 }) },
		});
		await reopening;
		expect(remoteSession.state.lifecycle).toEqual({ status: "ready" });
	});

	test("exposes the active operation while prompting", async () => {
		const server = new MemoryServer();
		const remoteSession = await openRemoteSession(await connectClient(server), server, sessionSnapshot("session-1"));
		const requests = collectRequests(server);
		const lifecycles: string[] = [];
		remoteSession.subscribe(({ lifecycle }) => {
			lifecycles.push(lifecycle.status === "busy" ? `${lifecycle.status}:${lifecycle.operation}` : lifecycle.status);
		});

		const prompting = remoteSession.submit("  first prompt  ");
		const request = requests.at(-1);
		expect(request?.request).toEqual({ command: "prompt", sessionId: "session-1", text: "first prompt" });
		expect(remoteSession.operation).toBe("submit");
		if (!request) throw new Error("Missing prompt request");
		server.send({
			type: "response",
			id: request.id,
			ok: true,
			result: { command: "prompt", session: sessionSnapshot("session-1", { revision: 2, phase: "turn" }) },
		});
		await prompting;

		expect(lifecycles).toEqual(["ready", "busy:submit", "busy:submit", "ready"]);
		expect(remoteSession.state.lifecycle).toEqual({ status: "ready" });
	});

	test("steers when the server session is in a turn", async () => {
		const server = new MemoryServer();
		const remoteSession = await openRemoteSession(
			await connectClient(server),
			server,
			sessionSnapshot("session-1", { phase: "turn" }),
		);
		const requests = collectRequests(server);

		const steering = remoteSession.submit("adjust");
		const request = requests.at(-1);
		expect(request?.request).toEqual({ command: "steer", sessionId: "session-1", text: "adjust" });
		if (!request) throw new Error("Missing steer request");
		server.send({
			type: "response",
			id: request.id,
			ok: true,
			result: { command: "steer", session: sessionSnapshot("session-1", { revision: 2, phase: "turn" }) },
		});
		await steering;
	});

	test("aborts while a prompt response is pending", async () => {
		const server = new MemoryServer();
		const remoteSession = await openRemoteSession(await connectClient(server), server, sessionSnapshot("session-1"));
		const requests = collectRequests(server);

		const prompting = remoteSession.submit("hello");
		const promptRequest = requests.at(-1);
		if (!promptRequest) throw new Error("Missing prompt request");
		server.send({
			type: "event",
			event: { type: "session_snapshot", snapshot: sessionSnapshot("session-1", { revision: 2, phase: "turn" }) },
		});

		const aborting = remoteSession.abort();
		const abortRequest = requests.at(-1);
		expect(abortRequest?.request).toEqual({ command: "abort", sessionId: "session-1" });
		expect(remoteSession.operation).toBe("abort");
		if (!abortRequest) throw new Error("Missing abort request");
		server.send({
			type: "response",
			id: promptRequest.id,
			ok: true,
			result: { command: "prompt", session: sessionSnapshot("session-1", { revision: 3, phase: "turn" }) },
		});
		await prompting;
		expect(remoteSession.operation).toBe("abort");
		server.send({
			type: "response",
			id: abortRequest.id,
			ok: true,
			result: { command: "abort", session: sessionSnapshot("session-1", { revision: 4 }) },
		});
		await aborting;
		expect(remoteSession.state.lifecycle).toEqual({ status: "ready" });
	});

	test("rejects conflicting operations while locally busy", async () => {
		const server = new MemoryServer();
		const remoteSession = await openRemoteSession(await connectClient(server), server, sessionSnapshot("session-1"));

		const requests = collectRequests(server);
		const prompting = remoteSession.submit("hello");
		await expect(remoteSession.setThinking("high")).rejects.toThrow("Remote session is busy with submit");
		await expect(remoteSession.open("session-2")).rejects.toThrow("Remote session is busy with submit");
		const request = requests.at(-1);
		if (!request) throw new Error("Missing prompt request");
		server.send({
			type: "response",
			id: request.id,
			ok: true,
			result: { command: "prompt", session: sessionSnapshot("session-1", { revision: 2, phase: "turn" }) },
		});
		await prompting;
	});

	test("reports subscriber failures without interrupting other subscribers", async () => {
		const server = new MemoryServer();
		const listenerErrors: Error[] = [];
		const remoteSession = await openRemoteSession(await connectClient(server), server, sessionSnapshot("session-1"), {
			onListenerError: (error) => listenerErrors.push(error),
		});
		remoteSession.subscribe(() => {
			throw new Error("render failed");
		});
		let notified = false;
		remoteSession.subscribe(() => {
			notified = true;
		});

		expect(listenerErrors.map(({ message }) => message)).toEqual(["render failed"]);
		expect(notified).toBe(true);
	});
});
