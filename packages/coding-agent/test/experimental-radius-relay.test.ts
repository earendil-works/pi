import type { Client } from "@earendil-works/pi-client";
import type { Server } from "@earendil-works/pi-server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RadiusRelayAuthResolver } from "../src/experimental/radius-auth.ts";
import {
	createRadiusClientTransportFactory,
	encodeRelayDataFrame,
	parseRelayDataFrame,
	RadiusClientReconnect,
	RadiusRelayHost,
	type RadiusRelayWebSocket,
	type RadiusRelayWebSocketFactory,
} from "../src/experimental/radius-relay.ts";
import { allowNetwork } from "./test-network-env.ts";

const serverId = "00000000-0000-4000-8000-000000000001";
const connectionId = "00000000-0000-4000-8000-000000000002";

type Listener = (event: unknown) => void;

class FakeWebSocket {
	readonly sent: Array<string | ArrayBuffer> = [];
	onSend: ((data: string | ArrayBuffer) => void) | undefined;
	readonly listeners = new Map<string, Set<Listener>>();
	binaryType: "arraybuffer" | "blob" = "blob";
	bufferedAmount = 0;
	protocol = "";
	readyState = 0;
	readonly OPEN = 1;

	addEventListener(type: string, listener: Listener): void {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: Listener): void {
		this.listeners.get(type)?.delete(listener);
	}

	send(data: string | ArrayBuffer): void {
		if (this.readyState !== this.OPEN) throw new Error("socket is not open");
		this.sent.push(data);
		this.onSend?.(data);
	}

	close(code = 1000, reason = ""): void {
		if (code !== 1000 && (code < 3000 || code > 4999)) {
			throw new DOMException("Invalid close code", "InvalidAccessError");
		}
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.emit("close", { code, reason });
	}

	open(protocol: string): void {
		this.protocol = protocol;
		this.readyState = this.OPEN;
		this.emit("open", {});
	}

	message(data: unknown): void {
		this.emit("message", { data });
	}

	remoteClose(code = 1006, reason = "lost"): void {
		this.readyState = 3;
		this.emit("close", { code, reason });
	}

	fail(error: Error): void {
		this.emit("error", { error, message: error.message });
	}

	abnormalClose(error: Error): void {
		this.readyState = 3;
		this.emit("error", { error, message: error.message });
		this.emit("close", { code: 1006, reason: "" });
	}

	private emit(type: string, event: unknown): void {
		for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
	}
}

function socketFactory() {
	const sockets: Array<{ socket: FakeWebSocket; options: Parameters<RadiusRelayWebSocketFactory>[0] }> = [];
	const factory: RadiusRelayWebSocketFactory = (options) => {
		const socket = new FakeWebSocket();
		sockets.push({ socket, options });
		return socket as unknown as RadiusRelayWebSocket;
	};
	return { sockets, factory };
}

beforeEach(() => allowNetwork());

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("experimental Radius relay", () => {
	test("matches the Radius multiplexing envelope", () => {
		const payload = Uint8Array.from([0, 1, 2, 255]);
		const parsed = parseRelayDataFrame(encodeRelayDataFrame(connectionId, payload));

		expect(parsed?.connectionId).toBe(connectionId);
		expect([...new Uint8Array(parsed!.payload)]).toEqual([...payload]);
	});

	test("bridges multiplexed host clients into independent server connections", async () => {
		const webSockets = socketFactory();
		const received: Uint8Array[] = [];
		let accepted:
			| {
					send(chunk: Uint8Array): Promise<void>;
					close(finalChunk?: Uint8Array): Promise<void>;
			  }
			| undefined;
		const onClose = vi.fn();
		const server = {
			accept(connection: typeof accepted) {
				accepted = connection;
				return {
					onData: (chunk: Uint8Array) => received.push(chunk.slice()),
					onClose,
					onError: vi.fn(),
				};
			},
		} as unknown as Pick<Server, "accept">;
		const statuses: string[] = [];
		const host = new RadiusRelayHost({
			serverId,
			server,
			auth: new RadiusRelayAuthResolver({ type: "token", token: "secret" }),
			webSocketFactory: webSockets.factory,
			onStatus: (status) => statuses.push(status.status),
		});
		host.start();
		await vi.waitFor(() => expect(webSockets.sockets).toHaveLength(1));
		const { socket, options } = webSockets.sockets[0]!;
		expect(options.authorization).toBe("Bearer secret");
		socket.open(options.protocol);
		await vi.waitFor(() => expect(statuses).toContain("connected"));

		socket.message(JSON.stringify({ version: 1, type: "connection_open", connection_id: connectionId }));
		expect(accepted).toBeDefined();
		const fromClient = Uint8Array.from([1, 2, 3]);
		socket.message(encodeRelayDataFrame(connectionId, fromClient));
		expect(received.map((chunk) => [...chunk])).toEqual([[1, 2, 3]]);

		await accepted!.send(Uint8Array.from([4, 5, 6]));
		const outbound = parseRelayDataFrame(socket.sent.at(-1) as ArrayBuffer);
		expect(outbound?.connectionId).toBe(connectionId);
		expect([...new Uint8Array(outbound!.payload)]).toEqual([4, 5, 6]);

		socket.message(JSON.stringify({ version: 1, type: "connection_close", connection_id: connectionId }));
		expect(onClose).toHaveBeenCalledOnce();
		await host.close();
	});

	test("reconnects the server host after the relay connection drops", async () => {
		vi.useFakeTimers();
		const webSockets = socketFactory();
		const statuses: string[] = [];
		const host = new RadiusRelayHost({
			serverId,
			server: { accept: vi.fn() } as unknown as Pick<Server, "accept">,
			auth: new RadiusRelayAuthResolver({ type: "token", token: "secret" }),
			webSocketFactory: webSockets.factory,
			onStatus: (status) => statuses.push(status.status),
		});
		host.start();
		await vi.waitFor(() => expect(webSockets.sockets).toHaveLength(1));
		webSockets.sockets[0]!.socket.open(webSockets.sockets[0]!.options.protocol);
		await vi.waitFor(() => expect(statuses).toContain("connected"));

		webSockets.sockets[0]!.socket.remoteClose();
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.waitFor(() => expect(webSockets.sockets).toHaveLength(2));
		await host.close();
	});

	test("uses a raw authenticated WebSocket as the client byte transport", async () => {
		const webSockets = socketFactory();
		const onData = vi.fn();
		const onClose = vi.fn();
		const onError = vi.fn();
		const transportPromise = createRadiusClientTransportFactory({
			serverId,
			auth: new RadiusRelayAuthResolver({ type: "token", token: "secret" }),
			webSocketFactory: webSockets.factory,
		})({ onData, onClose, onError });
		await vi.waitFor(() => expect(webSockets.sockets).toHaveLength(1));
		const { socket, options } = webSockets.sockets[0]!;
		expect(options.authorization).toBe("Bearer secret");
		socket.open(options.protocol);
		const transport = await transportPromise;

		await transport.send(Uint8Array.from([1, 2, 3]));
		expect([...new Uint8Array(socket.sent[0] as ArrayBuffer)]).toEqual([1, 2, 3]);
		socket.message(Uint8Array.from([4, 5, 6]).buffer);
		expect(onData).toHaveBeenCalledOnce();
		expect([...onData.mock.calls[0]![0]]).toEqual([4, 5, 6]);
		socket.remoteClose();
		expect(onClose).toHaveBeenCalledOnce();
		expect(onError).not.toHaveBeenCalled();
	});

	test("reports established abnormal closures so the client can reconnect", async () => {
		const webSockets = socketFactory();
		const onClose = vi.fn();
		const onError = vi.fn();
		const transportPromise = createRadiusClientTransportFactory({
			serverId,
			auth: new RadiusRelayAuthResolver({ type: "token", token: "secret" }),
			webSocketFactory: webSockets.factory,
		})({ onData: vi.fn(), onClose, onError });
		await vi.waitFor(() => expect(webSockets.sockets).toHaveLength(1));
		const { socket, options } = webSockets.sockets[0]!;
		socket.open(options.protocol);
		await transportPromise;

		expect(() => socket.abnormalClose(new Error("network lost"))).not.toThrow();
		expect(onError).toHaveBeenCalledOnce();
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "network lost" }));
		expect(onClose).not.toHaveBeenCalled();
	});

	test("reports a useful error when Undici omits WebSocket failure details", async () => {
		const webSockets = socketFactory();
		const opening = createRadiusClientTransportFactory({
			serverId,
			auth: new RadiusRelayAuthResolver({ type: "token", token: "secret" }),
			webSocketFactory: webSockets.factory,
		})({ onData: vi.fn(), onClose: vi.fn(), onError: vi.fn() });
		const failure = expect(opening).rejects.toThrow("Radius WebSocket connection failed");
		await vi.waitFor(() => expect(webSockets.sockets).toHaveLength(1));
		webSockets.sockets[0]!.socket.fail(new Error(""));
		await failure;
	});

	test("reconnects an established client and restores its selected Session", async () => {
		vi.useFakeTimers();
		const connectionListeners = new Set<(change: { state: string }) => void>();
		const attachmentListeners = new Set<(attachment: { sessionId: string } | undefined) => void>();
		let attempts = 0;
		const reattach = vi.fn(async () => {});
		const client = {
			connected: true,
			connectionState: "connected",
			attachment: { sessionId: "demo-1" },
			onConnectionStateChange(listener: (change: { state: string }) => void) {
				connectionListeners.add(listener);
				return () => connectionListeners.delete(listener);
			},
			onAttachmentChange(listener: (attachment: { sessionId: string } | undefined) => void) {
				attachmentListeners.add(listener);
				return () => attachmentListeners.delete(listener);
			},
			async reconnect() {
				attempts++;
				if (attempts === 1) throw new Error("temporary failure");
				this.connected = true;
				this.connectionState = "connected";
				for (const listener of connectionListeners) listener({ state: "connected" });
				return { serverId };
			},
			disconnect() {
				this.connected = false;
				this.connectionState = "disconnected";
				for (const listener of connectionListeners) listener({ state: "disconnected" });
			},
		};
		const reconnect = new RadiusClientReconnect(client as unknown as Client, reattach);
		client.disconnect();

		await vi.advanceTimersByTimeAsync(1_000);
		expect(attempts).toBe(1);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(attempts).toBe(2);
		expect(reattach).toHaveBeenCalledWith("demo-1");
		await reconnect.dispose();
	});
});
