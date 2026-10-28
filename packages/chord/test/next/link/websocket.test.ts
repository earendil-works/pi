import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";
import { type WebSocketLike, webSocketLink } from "../../../src/next/link/index.ts";
import { Notes, serveNotes, type TestPrincipal, transported } from "../support.ts";

/** A socket playing a WebSocket by hand. */
class FakeSocket implements WebSocketLike {
	readyState: number;
	binaryType = "blob";
	readonly sent: Uint8Array[] = [];
	closes = 0;
	readonly #listeners = new Map<string, Set<(event: { readonly data: unknown }) => void>>();

	constructor(readyState: number) {
		this.readyState = readyState;
	}

	send(data: Uint8Array): void {
		this.sent.push(data);
	}

	close(): void {
		this.closes++;
		this.readyState = 3;
	}

	addEventListener(type: string, listener: (event: { readonly data: unknown }) => void): void {
		const listeners = this.#listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.#listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: (event: { readonly data: unknown }) => void): void {
		this.#listeners.get(type)?.delete(listener);
	}

	emit(type: string, data?: unknown): void {
		if (type === "open") this.readyState = 1;
		for (const listener of [...(this.#listeners.get(type) ?? [])]) listener({ data });
	}

	get listeners(): number {
		return [...this.#listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
	}
}

describe("WebSocket links over a fake socket", () => {
	it("buffer messages sent while connecting and send them on open, as binary frames (race 29)", () => {
		const socket = new FakeSocket(0);
		const link = webSocketLink(socket);
		expect(socket.binaryType).toBe("arraybuffer");
		link.send(new Uint8Array([1]));
		link.send(new Uint8Array([2]));
		expect(socket.sent).toEqual([]);
		socket.emit("open");
		expect(socket.sent.map((message) => message[0])).toEqual([1, 2]);
		const received: number[] = [];
		link.onMessage((message) => received.push(message[0]!));
		socket.emit("message", new Uint8Array([7]).buffer);
		expect(received).toEqual([7]);
	});

	it("give a closed link for a socket closing or closed already", () => {
		for (const state of [2, 3]) {
			let closed = false;
			webSocketLink(new FakeSocket(state)).onClose(() => {
				closed = true;
			});
			expect(closed).toBe(true);
		}
	});

	it.each([
		["close", (socket: FakeSocket) => socket.emit("close")],
		["error", (socket: FakeSocket) => socket.emit("error")],
		["a text frame", (socket: FakeSocket) => socket.emit("message", "text")],
	])("close once on %s, listeners removed", (_, fail) => {
		const socket = new FakeSocket(1);
		const link = webSocketLink(socket);
		let closes = 0;
		link.onClose(() => closes++);
		fail(socket);
		socket.emit("close");
		link.send(new Uint8Array([1]));
		expect(closes).toBe(1);
		expect(socket.sent).toEqual([]);
		expect(socket.listeners).toBe(0);
	});
});

/** A `ws` server on a free loopback port whose connections a server host accepts, and a URL to it. */
async function loopback(options: { readonly maxPayload?: number } = {}) {
	const server = createHost<TestPrincipal>({ principal: { kind: "server" }, onError: () => {} });
	await server.load([{ name: "@test/app", facet: defineFacet<TestPrincipal>((h) => void serveNotes(h)) }], context);
	const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", maxPayload: options.maxPayload });
	await new Promise<void>((resolve) => wss.once("listening", resolve));
	wss.on("connection", (socket) => server.accept(webSocketLink(socket), { principal: { kind: "owner" } }, context));
	const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
	return { server, wss, url };
}

describe("WebSocket links over a loopback ws server", () => {
	it("survive closing a socket that still connects: ws's late error is handled", async () => {
		const errors: unknown[] = [];
		const record = (error: unknown) => errors.push(error);
		process.on("uncaughtException", record);
		try {
			const socket = new WebSocket("ws://127.0.0.1:1");
			let closed = false;
			const link = webSocketLink(socket);
			link.onClose(() => {
				closed = true;
			});
			link.close();
			expect(closed).toBe(true);
			await new Promise<void>((resolve) => socket.once("close", () => resolve()));
			expect(errors).toEqual([]);
			expect(socket.listenerCount("error")).toBe(0);
		} finally {
			process.off("uncaughtException", record);
		}
	});

	it("carry a live reference both ways; the client's hello waits for open", async () => {
		const { server, wss, url } = await loopback();
		const tab = createHost<TestPrincipal>({ onError: () => {} });
		await tab.load([], context);
		tab.connect(webSocketLink(new WebSocket(url)), { principal: { kind: "server" } }, context);
		const notes = await tab.get(Notes, { session: "S1" }, context);
		if (notes.variant !== "editor") throw new Error("expected the editor");
		expect(await notes.add({ text: "over ws" }, context)).toBe(1);
		await transported();
		expect(notes.notes.value).toEqual([{ text: "over ws" }]);
		await tab.close(context);
		await server.close(context);
		await new Promise((resolve) => wss.close(resolve));
	});

	it("close the connection on a frame above maxPayload (1009): references go loading (race 28)", async () => {
		const { server, wss, url } = await loopback({ maxPayload: 4096 });
		const tab = createHost<TestPrincipal>({ onError: () => {} });
		await tab.load([], context);
		const socket = new WebSocket(url);
		const code = new Promise<number>((resolve) => socket.once("close", resolve));
		tab.connect(webSocketLink(socket), { principal: { kind: "server" } }, context);
		const notes = await tab.get(Notes, { session: "S1" }, context);
		if (notes.variant !== "editor") throw new Error("expected the editor");
		const call = notes.echo({ data: new Uint8Array(10_000) }, context).catch((error: unknown) => error);
		expect(await code).toBe(1009);
		expect(await call).toMatchObject({ code: "unavailable" });
		expect(notes.state.value).toEqual({ kind: "loading" });
		await tab.close(context);
		await server.close(context);
		await new Promise((resolve) => wss.close(resolve));
	});
});
