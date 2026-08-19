import { describe, expect, test } from "vitest";
import { PiSessionDetachedError, PiSessionOwnershipError } from "../src/index.ts";
import { connectClient, MemoryByteServer, sessionSnapshot } from "./support.ts";

describe("PiClient", () => {
	test("keeps multiple session handles independent and enforces detach", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		server.onMessage((message) => {
			if (message.type !== "request") return;
			const request = message.request;
			if (request.command === "attach") {
				server.send({
					type: "response",
					id: message.id,
					ok: true,
					result: { command: "attach", session: sessionSnapshot(request.sessionId) },
				});
			}
			if (request.command === "detach") {
				server.send({
					type: "response",
					id: message.id,
					ok: true,
					result: { command: "detach", sessionId: request.sessionId },
				});
			}
		});

		const first = await client.attachSession("session-1");
		const second = await client.attachSession("session-2");
		expect(first.attached).toBe(true);
		expect(second.attached).toBe(true);
		await first.detach();
		expect(first.attached).toBe(false);
		expect(second.attached).toBe(true);
		await expect(first.abort()).rejects.toBeInstanceOf(PiSessionDetachedError);
	});

	test("detaches a shared session only after its final lease is released", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests: string[] = [];
		server.onMessage((message) => {
			if (message.type !== "request") return;
			requests.push(message.request.command);
			if (message.request.command === "attach") {
				server.send({
					type: "response",
					id: message.id,
					ok: true,
					result: { command: "attach", session: sessionSnapshot("session-1") },
				});
			}
			if (message.request.command === "detach") {
				server.send({
					type: "response",
					id: message.id,
					ok: true,
					result: { command: "detach", sessionId: "session-1" },
				});
			}
		});

		const first = await client.attachSession("session-1");
		const second = await client.attachSession("session-1");
		expect(second).not.toBe(first);
		expect(requests).toEqual(["attach"]);

		await first.detach();
		expect(first.attached).toBe(false);
		expect(second.attached).toBe(true);
		expect(requests).toEqual(["attach"]);

		await second.detach();
		expect(second.attached).toBe(false);
		expect(requests).toEqual(["attach", "detach"]);
	});

	test("enforces exclusive and shared lease modes", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		server.onMessage((message) => {
			if (message.type !== "request") return;
			if (message.request.command === "attach") {
				server.send({
					type: "response",
					id: message.id,
					ok: true,
					result: { command: "attach", session: sessionSnapshot("session-1") },
				});
			}
			if (message.request.command === "detach") {
				server.send({
					type: "response",
					id: message.id,
					ok: true,
					result: { command: "detach", sessionId: "session-1" },
				});
			}
		});

		const shared = await client.acquireSession("session-1", { mode: "shared" });
		await expect(client.acquireSession("session-1", { mode: "exclusive" })).rejects.toBeInstanceOf(
			PiSessionOwnershipError,
		);
		await shared.dispose();

		const exclusive = await client.acquireSession("session-1", { mode: "exclusive" });
		await expect(client.acquireSession("session-1", { mode: "shared" })).rejects.toBeInstanceOf(
			PiSessionOwnershipError,
		);
		await exclusive[Symbol.asyncDispose]();
	});

	test("invalidated leases dispose without protocol cleanup", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		server.onMessage((message) => {
			if (message.type !== "request" || message.request.command !== "attach") return;
			server.send({
				type: "response",
				id: message.id,
				ok: true,
				result: { command: "attach", session: sessionSnapshot("session-1") },
			});
		});
		const lease = await client.acquireSession("session-1", { mode: "exclusive" });

		client.disconnect();

		await expect(lease.dispose()).resolves.toBeUndefined();
		expect(lease.active).toBe(false);
	});

	test("rejects commands while releasing and restores an explicit detach after failure", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests: Array<{ id: string; command: string }> = [];
		server.onMessage((message) => {
			if (message.type !== "request") return;
			requests.push({ id: message.id, command: message.request.command });
		});
		const acquiring = client.acquireSession("session-1", { mode: "exclusive" });
		const attachRequest = requests.at(-1);
		if (!attachRequest) throw new Error("Missing attach request");
		server.send({
			type: "response",
			id: attachRequest.id,
			ok: true,
			result: { command: "attach", session: sessionSnapshot("session-1") },
		});
		const lease = await acquiring;

		const firstDetach = lease.detach();
		const failedDetachRequest = requests.at(-1);
		await expect(lease.abort()).rejects.toBeInstanceOf(PiSessionDetachedError);
		if (!failedDetachRequest) throw new Error("Missing detach request");
		server.send({
			type: "response",
			id: failedDetachRequest.id,
			ok: false,
			error: { code: "invalid_request", message: "retry" },
		});
		await expect(firstDetach).rejects.toThrow("retry");
		expect(lease.active).toBe(true);

		const secondDetach = lease.detach();
		const successfulDetachRequest = requests.at(-1);
		if (!successfulDetachRequest) throw new Error("Missing retry detach request");
		server.send({
			type: "response",
			id: successfulDetachRequest.id,
			ok: true,
			result: { command: "detach", sessionId: "session-1" },
		});
		await secondDetach;
		expect(lease.active).toBe(false);
	});

	test("serializes reacquisition behind final lease detachment", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests: Array<{ id: string; command: string }> = [];
		server.onMessage((message) => {
			if (message.type !== "request") return;
			requests.push({ id: message.id, command: message.request.command });
		});

		const firstAttachment = client.attachSession("session-1");
		const firstAttachRequest = requests.at(-1);
		if (!firstAttachRequest) throw new Error("Missing first attach request");
		server.send({
			type: "response",
			id: firstAttachRequest.id,
			ok: true,
			result: { command: "attach", session: sessionSnapshot("session-1") },
		});
		const first = await firstAttachment;
		const detaching = first.detach();
		const detachRequest = requests.at(-1);
		if (!detachRequest) throw new Error("Missing detach request");
		const reacquiring = client.attachSession("session-1");
		expect(requests.map(({ command }) => command)).toEqual(["attach", "detach"]);

		server.send({
			type: "response",
			id: detachRequest.id,
			ok: true,
			result: { command: "detach", sessionId: "session-1" },
		});
		await detaching;
		await Promise.resolve();
		const secondAttachRequest = requests.at(-1);
		expect(secondAttachRequest?.command).toBe("attach");
		if (!secondAttachRequest) throw new Error("Missing second attach request");
		server.send({
			type: "response",
			id: secondAttachRequest.id,
			ok: true,
			result: { command: "attach", session: sessionSnapshot("session-1", { revision: 2 }) },
		});

		await expect(reacquiring).resolves.toMatchObject({ attached: true });
	});

	test("accepts a lower revision after detaching and reacquiring the same session", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		let attachCount = 0;
		server.onMessage((message) => {
			if (message.type !== "request") return;
			if (message.request.command === "attach") {
				server.send({
					type: "response",
					id: message.id,
					ok: true,
					result: {
						command: "attach",
						session: sessionSnapshot("session-1", { revision: attachCount++ === 0 ? 10 : 0 }),
					},
				});
			}
			if (message.request.command === "detach") {
				server.send({
					type: "response",
					id: message.id,
					ok: true,
					result: { command: "detach", sessionId: "session-1" },
				});
			}
		});

		const first = await client.attachSession("session-1");
		expect(first.snapshot?.revision).toBe(10);
		await first.detach();
		const reopened = await client.attachSession("session-1");
		expect(reopened).not.toBe(first);
		expect(reopened.snapshot?.revision).toBe(0);
	});
});
