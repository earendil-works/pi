import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type IpcPort, ipcLink } from "../../../src/next/link/index.ts";
import { flushed } from "../support.ts";

/** A port playing a Node IPC channel by hand: what was sent, its listeners, and what the test makes happen. */
class FakePort implements IpcPort {
	connected = true;
	readonly sent: Uint8Array[] = [];
	/** What `send` returns, or throws when an error. */
	next: boolean | Error = true;
	callbacks: ((error: Error | null) => void)[] = [];
	disconnects = 0;
	readonly #message = new Set<(message: unknown) => void>();
	readonly #disconnect = new Set<() => void>();

	send(message: Uint8Array, callback: (error: Error | null) => void): boolean {
		if (this.next instanceof Error) throw this.next;
		this.sent.push(message);
		this.callbacks.push(callback);
		return this.next;
	}

	on(event: "message" | "disconnect", listener: (message: unknown) => void): this {
		if (event === "message") this.#message.add(listener);
		else this.#disconnect.add(listener as () => void);
		return this;
	}

	removeListener(event: "message" | "disconnect", listener: (message: unknown) => void): this {
		if (event === "message") this.#message.delete(listener);
		else this.#disconnect.delete(listener as () => void);
		return this;
	}

	disconnect(): void {
		this.disconnects++;
		this.connected = false;
		for (const listener of [...this.#disconnect]) listener();
	}

	receive(message: unknown): void {
		for (const listener of [...this.#message]) listener(message);
	}

	get listeners(): number {
		return this.#message.size + this.#disconnect.size;
	}
}

describe("IPC links over a fake port", () => {
	it("deliver Uint8Array messages in order, queued until the listener is set; other messages are not the link's", () => {
		const port = new FakePort();
		const link = ipcLink(port);
		port.receive(new Uint8Array([1]));
		port.receive({ start: "the app's own" });
		port.receive(new Uint8Array([2]));
		const received: number[] = [];
		link.onMessage((message) => received.push(message[0]!));
		port.receive(new Uint8Array([3]));
		expect(received).toEqual([1, 2, 3]);
	});

	it("treat send returning false as backpressure, not a close", () => {
		const port = new FakePort();
		const link = ipcLink(port);
		let closed = 0;
		link.onClose(() => closed++);
		port.next = false;
		link.send(new Uint8Array([1]));
		link.send(new Uint8Array([2]));
		expect(port.sent).toHaveLength(2);
		expect(closed).toBe(0);
	});

	it.each([
		[
			"a thrown send",
			(port: FakePort) => {
				port.next = new Error("channel closed");
			},
		],
		["an error in the send callback", (port: FakePort) => port.callbacks[0]!(new Error("EPIPE"))],
		["a disconnect", (port: FakePort) => port.disconnect()],
	])("close once on %s; listeners removed, later messages dropped (race 27)", (_, fail) => {
		const port = new FakePort();
		const link = ipcLink(port);
		let closed = 0;
		const received: Uint8Array[] = [];
		link.onClose(() => closed++);
		link.onMessage((message) => received.push(message));
		link.send(new Uint8Array([1]));
		fail(port);
		link.send(new Uint8Array([2]));
		port.disconnect();
		port.receive(new Uint8Array([3]));
		expect(closed).toBe(1);
		expect(received).toEqual([]);
		expect(port.listeners).toBe(0);
	});

	it("disconnect the port on close, once; a port not connected gives a closed link", () => {
		const port = new FakePort();
		const link = ipcLink(port);
		link.close();
		link.close();
		expect(port.disconnects).toBe(1);
		let closed = false;
		ipcLink(port).onClose(() => {
			closed = true;
		});
		expect(closed).toBe(true);
	});
});

describe("IPC links to a forked child", () => {
	it("carry Uint8Array messages both ways and close when the child exits mid-send (race 27)", async () => {
		const child = fork(fileURLToPath(new URL("./fixtures/ipc-echo.ts", import.meta.url)), [], {
			serialization: "advanced",
			execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
		});
		const link = ipcLink(child);
		const echoed = new Promise<Uint8Array>((resolve) => link.onMessage(resolve));
		let closes = 0;
		const closed = new Promise<void>((resolve) =>
			link.onClose(() => {
				closes++;
				resolve();
			}),
		);
		link.send(new Uint8Array([1, 2, 3]));
		const message = await echoed;
		expect(message).toBeInstanceOf(Uint8Array);
		expect([...message]).toEqual([1, 2, 3]);
		// The child exits on this one; the sends after it race the exit.
		link.send(new Uint8Array([0xff]));
		for (let send = 0; send < 20; send++) link.send(new Uint8Array(1024));
		await closed;
		await flushed();
		expect(closes).toBe(1);
	}, 20_000);
});
