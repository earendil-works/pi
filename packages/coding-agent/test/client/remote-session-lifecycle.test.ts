import type { RequestEnvelope } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { collectRequests, connectClient, MemoryServer, openRemoteSession, sessionSnapshot } from "./support.ts";

function nextRequest(server: MemoryServer, command: RequestEnvelope["request"]["command"]): Promise<RequestEnvelope> {
	return new Promise((resolve) => {
		const unsubscribe = server.onMessage((message) => {
			if (message.type !== "request" || message.request.command !== command) return;
			unsubscribe();
			resolve(message);
		});
	});
}

describe("RemoteSession lifecycle", () => {
	test("opens a replacement before detaching the current session", async () => {
		const server = new MemoryServer();
		const remoteSession = await openRemoteSession(await connectClient(server), server, sessionSnapshot("session-1"));
		const requests = collectRequests(server);

		const opening = remoteSession.open("session-2");
		const attachRequest = requests.at(-1);
		if (!attachRequest) throw new Error("Missing attach request");
		const detachRequestPromise = nextRequest(server, "detach");
		server.send({
			type: "response",
			id: attachRequest.id,
			ok: true,
			result: { command: "attach", session: sessionSnapshot("session-2") },
		});
		const detachRequest = await detachRequestPromise;
		expect(detachRequest.request).toEqual({ command: "detach", sessionId: "session-1" });
		server.send({
			type: "response",
			id: detachRequest.id,
			ok: true,
			result: { command: "detach", sessionId: "session-1" },
		});
		await opening;

		expect(remoteSession.id).toBe("session-2");
	});

	test("rejects another mutation while replacement attachment is pending", async () => {
		const server = new MemoryServer();
		const remoteSession = await openRemoteSession(await connectClient(server), server, sessionSnapshot("session-1"));
		const requests = collectRequests(server);

		const opening = remoteSession.open("session-2");
		await expect(remoteSession.submit("race")).rejects.toThrow("Remote session is busy with open");
		await expect(remoteSession.create({ cwd: "/other" })).rejects.toThrow("Remote session is busy with open");
		expect(requests.map(({ request }) => request)).toEqual([{ command: "attach", sessionId: "session-2" }]);

		const attachRequest = requests[0];
		if (!attachRequest) throw new Error("Missing attach request");
		const detachRequestPromise = nextRequest(server, "detach");
		server.send({
			type: "response",
			id: attachRequest.id,
			ok: true,
			result: { command: "attach", session: sessionSnapshot("session-2") },
		});
		const detachRequest = await detachRequestPromise;
		server.send({
			type: "response",
			id: detachRequest.id,
			ok: true,
			result: { command: "detach", sessionId: "session-1" },
		});
		await opening;
	});

	test("rolls back a replacement when the current server session becomes active", async () => {
		const server = new MemoryServer();
		const remoteSession = await openRemoteSession(await connectClient(server), server, sessionSnapshot("session-1"));
		const requests = collectRequests(server);

		const opening = remoteSession.open("session-2");
		const attachRequest = requests.at(-1);
		if (!attachRequest) throw new Error("Missing attach request");
		const detachRequestPromise = nextRequest(server, "detach");
		server.send({
			type: "event",
			event: {
				type: "session_snapshot",
				snapshot: sessionSnapshot("session-1", { phase: "turn", revision: 2 }),
			},
		});
		server.send({
			type: "response",
			id: attachRequest.id,
			ok: true,
			result: { command: "attach", session: sessionSnapshot("session-2") },
		});
		const detachRequest = await detachRequestPromise;
		expect(detachRequest.request).toEqual({ command: "detach", sessionId: "session-2" });
		server.send({
			type: "response",
			id: detachRequest.id,
			ok: true,
			result: { command: "detach", sessionId: "session-2" },
		});

		await expect(opening).rejects.toThrow("Cannot open a session while session is turn");
		expect(remoteSession.id).toBe("session-1");
		expect(remoteSession.state.lifecycle).toEqual({ status: "ready" });
	});

	test("dispose awaits attachment cleanup started by reconnect", async () => {
		const server = new MemoryServer();
		const client = await connectClient(server);
		const remoteSession = await openRemoteSession(client, server, sessionSnapshot("session-1"));
		client.disconnect("test reconnect");
		const attachRequestPromise = nextRequest(server, "attach");

		const reconnecting = remoteSession.reconnect();
		const attachRequest = await attachRequestPromise;
		const disposing = remoteSession.dispose();
		let disposalSettled = false;
		void disposing.then(() => {
			disposalSettled = true;
		});
		await expect(reconnecting).rejects.toThrow("Remote session is disposed");
		const detachRequestPromise = nextRequest(server, "detach");
		server.send({
			type: "response",
			id: attachRequest.id,
			ok: true,
			result: { command: "attach", session: sessionSnapshot("session-1", { revision: 2 }) },
		});
		const detachRequest = await detachRequestPromise;
		expect(disposalSettled).toBe(false);
		server.send({
			type: "response",
			id: detachRequest.id,
			ok: true,
			result: { command: "detach", sessionId: "session-1" },
		});

		await disposing;
		expect(disposalSettled).toBe(true);
		expect(client.connected).toBe(true);
	});

	test("dispose immediately preempts pending work and awaits attachment cleanup", async () => {
		const server = new MemoryServer();
		const client = await connectClient(server);
		const remoteSession = await openRemoteSession(client, server, sessionSnapshot("session-1"));
		const states: string[] = [];
		remoteSession.subscribe(({ lifecycle }) => states.push(lifecycle.status));
		const requests = collectRequests(server);

		const opening = remoteSession.open("session-2");
		const attachRequest = requests.find(({ request }) => request.command === "attach");
		if (!attachRequest) throw new Error("Missing attach request");
		const disposing = remoteSession.dispose();
		const currentDetachRequest = requests.find(
			({ request }) => request.command === "detach" && request.sessionId === "session-1",
		);
		if (!currentDetachRequest) throw new Error("Missing current detach request");

		expect(client.connected).toBe(true);
		expect(remoteSession.state.lifecycle).toEqual({ status: "disposed" });
		await expect(opening).rejects.toThrow();
		const replacementDetachRequestPromise = nextRequest(server, "detach");
		server.send({
			type: "response",
			id: attachRequest.id,
			ok: true,
			result: { command: "attach", session: sessionSnapshot("session-2") },
		});
		server.send({
			type: "response",
			id: currentDetachRequest.id,
			ok: true,
			result: { command: "detach", sessionId: "session-1" },
		});
		const replacementDetachRequest = await replacementDetachRequestPromise;
		expect(replacementDetachRequest.request).toEqual({ command: "detach", sessionId: "session-2" });
		server.send({
			type: "response",
			id: replacementDetachRequest.id,
			ok: true,
			result: { command: "detach", sessionId: "session-2" },
		});
		await disposing;
		expect(states).toContain("disposed");
		expect(() => remoteSession.subscribe(() => {})).toThrow("Remote session is disposed");
	});
});
