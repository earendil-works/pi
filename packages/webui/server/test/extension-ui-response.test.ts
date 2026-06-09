import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { SessionPool } from "../session-pool";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Per-test homedir override
// ---------------------------------------------------------------------------
let currentTmpBase = "/tmp/pi-extension-ui-response-test";

vi.mock("node:os", () => ({
	homedir: () => currentTmpBase,
}));

// ---------------------------------------------------------------------------
// Mock proc factory (mirrors session-pool.test.ts pattern)
// ---------------------------------------------------------------------------
function makeMockProc() {
	const proc = vi.fn() as ReturnType<typeof vi.fn> & {
		stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
		stdout: { on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn> };
		stderr: { on: ReturnType<typeof vi.fn> };
		on: ReturnType<typeof vi.fn>;
		once: ReturnType<typeof vi.fn>;
		kill: ReturnType<typeof vi.fn>;
		pid: number;
		killed: boolean;
	};

	proc.stdin = { write: vi.fn(), end: vi.fn() };
	proc.stdout = { on: vi.fn(), off: vi.fn() };
	proc.stderr = { on: vi.fn() };
	proc.on = vi.fn().mockReturnThis();
	proc.once = vi.fn().mockReturnThis();
	proc.kill = vi.fn();
	proc.pid = 12345;
	proc.killed = false;

	return { proc };
}

// ---------------------------------------------------------------------------
// Fake SessionPool for ws-handler tests (mirrors ws-handler.test.ts pattern)
// ---------------------------------------------------------------------------
interface FakePool {
	subscribe: ReturnType<typeof vi.fn>;
	unsubscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
	spawnIfNeeded: ReturnType<typeof vi.fn>;
	broadcast: ReturnType<typeof vi.fn>;
	setSessionName: ReturnType<typeof vi.fn>;
	getTitlesSeen: ReturnType<typeof vi.fn>;
	sendExtensionUIResponse: ReturnType<typeof vi.fn>;
	_eventListeners: Map<string, Set<(...args: unknown[]) => void>>;
	_emit: (event: string, ...args: unknown[]) => void;
}

function createFakePool(): FakePool {
	const listeners: Map<string, Set<(...args: unknown[]) => void>> = new Map();
	const pool: FakePool = {
		subscribe: vi.fn(),
		unsubscribe: vi.fn(),
		prompt: vi.fn().mockResolvedValue(undefined),
		abort: vi.fn(),
		spawnIfNeeded: vi.fn().mockResolvedValue(undefined),
		broadcast: vi.fn(),
		setSessionName: vi.fn().mockResolvedValue(undefined),
		getTitlesSeen: vi.fn().mockReturnValue(new Set<string>()),
		sendExtensionUIResponse: vi.fn(),
		_eventListeners: listeners,
		_emit(event: string, ...args: unknown[]) {
			listeners.get(event)?.forEach((fn) => fn(...args));
		},
	} as unknown as FakePool;
	(pool as unknown as { on: (...a: unknown[]) => void }).on = vi.fn().mockImplementation(
		(event: string, fn: (...args: unknown[]) => void) => {
			if (!listeners.has(event)) listeners.set(event, new Set());
			listeners.get(event)!.add(fn);
		},
	);
	return pool;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const TEST_PORT = 18763;

function waitForMs(ms: number): Promise<void> {
	return new Promise((res) => setTimeout(res, ms));
}

// ---------------------------------------------------------------------------
// Task 2.1: SessionPool.sendExtensionUIResponse tests
// ---------------------------------------------------------------------------
describe("SessionPool.sendExtensionUIResponse", () => {
	const tmpBase = "/tmp/pi-extension-ui-response-test";

	beforeEach(async () => {
		vi.clearAllMocks();
		currentTmpBase = tmpBase;
		await rm(tmpBase, { recursive: true, force: true });
		await mkdir(join(tmpBase, ".pi", "agent", "sessions", "--test--"), {
			recursive: true,
		});
	});

	afterEach(async () => {
		await rm(tmpBase, { recursive: true, force: true });
	});

	// -------------------------------------------------------------------------
	// (a) writes extension_ui_response JSON to proc.stdin
	// -------------------------------------------------------------------------
	it("(a) writes extension_ui_response JSON to proc.stdin", async () => {
		const { proc } = makeMockProc();
		proc.once.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
			if (event === "exit") setTimeout(() => cb(0, null), 0);
			return proc;
		});

		const pool = new SessionPool({ cwd: "/test", spawnFn: () => proc });
		await pool.spawnIfNeeded("test-session");

		pool.sendExtensionUIResponse("test-session", { id: "abc-123", value: "Option 1" });

		expect(proc.stdin.write).toHaveBeenCalledOnce();
		expect(proc.stdin.write).toHaveBeenCalledWith(
			'{"type":"extension_ui_response","id":"abc-123","value":"Option 1"}\n',
		);
	});

	// -------------------------------------------------------------------------
	// (b) silent ignore when session does not exist
	// -------------------------------------------------------------------------
	it("(b) silent ignore when session does not exist", () => {
		const { proc } = makeMockProc();
		const pool = new SessionPool({ cwd: "/test", spawnFn: () => proc });

		expect(() => pool.sendExtensionUIResponse("nonexistent", { id: "x", value: "y" })).not.toThrow();
		expect(proc.stdin.write).not.toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// (c) silent ignore when proc has already exited
	// -------------------------------------------------------------------------
	it("(c) silent ignore when proc has already exited", async () => {
		const { proc } = makeMockProc();
		// Simulate exit already fired — proc still in sessions map but dead
		const pool = new SessionPool({ cwd: "/test", spawnFn: () => proc });
		await pool.spawnIfNeeded("dead-session");
		// Simulate the proc being gone from the session (e.g. killed)
		// We achieve this by removing the proc from the internal state directly
		const sessionState = (pool as unknown as { sessions: Map<string, { proc: unknown }> }).sessions.get("dead-session");
		if (sessionState) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(sessionState as any).proc = null;
		}

		expect(() => pool.sendExtensionUIResponse("dead-session", { id: "x", value: "y" })).not.toThrow();
		expect(proc.stdin.write).not.toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// (d) supports confirmed field
	// -------------------------------------------------------------------------
	it("(d) supports confirmed field", async () => {
		const { proc } = makeMockProc();
		proc.once.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
			if (event === "exit") setTimeout(() => cb(0, null), 0);
			return proc;
		});

		const pool = new SessionPool({ cwd: "/test", spawnFn: () => proc });
		await pool.spawnIfNeeded("test-session");

		pool.sendExtensionUIResponse("test-session", { id: "x", confirmed: true });

		expect(proc.stdin.write).toHaveBeenCalledOnce();
		const written = proc.stdin.write.mock.calls[0][0] as string;
		const parsed = JSON.parse(written);
		expect(parsed).toMatchObject({ type: "extension_ui_response", id: "x", confirmed: true });
		// value should not be present when not provided
		expect(parsed.value).toBeUndefined();
	});

	// -------------------------------------------------------------------------
	// (e) supports cancelled field
	// -------------------------------------------------------------------------
	it("(e) supports cancelled field", async () => {
		const { proc } = makeMockProc();
		proc.once.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
			if (event === "exit") setTimeout(() => cb(0, null), 0);
			return proc;
		});

		const pool = new SessionPool({ cwd: "/test", spawnFn: () => proc });
		await pool.spawnIfNeeded("test-session");

		pool.sendExtensionUIResponse("test-session", { id: "x", cancelled: true });

		expect(proc.stdin.write).toHaveBeenCalledOnce();
		const written = proc.stdin.write.mock.calls[0][0] as string;
		const parsed = JSON.parse(written);
		expect(parsed).toMatchObject({ type: "extension_ui_response", id: "x", cancelled: true });
		expect(parsed.value).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Task 2.3: ws handler routing for extension_ui_response
// ---------------------------------------------------------------------------
describe("WsHandler extension_ui_response routing", () => {
	let server: Server;
	let wss: WebSocketServer;
	let attachWsHandler: (httpServer: Server, pool: import("../session-pool").SessionPool) => WebSocketServer;

	beforeEach(async () => {
		const mod = await import("../ws/handler");
		attachWsHandler = mod.attachWsHandler;
	});

	afterEach(() => {
		wss?.close();
		server?.close();
	});

	// -------------------------------------------------------------------------
	// (a) extension_ui_response message → calls pool.sendExtensionUIResponse
	// -------------------------------------------------------------------------
	it("(a) extension_ui_response → calls pool.sendExtensionUIResponse", async () => {
		const pool = createFakePool();

		server = createServer();
		wss = attachWsHandler(server, pool as unknown as import("../session-pool").SessionPool);

		await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
		const addr = server.address() as { port: number };

		const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
		await new Promise<void>((res) => ws.on("open", res));

		// Subscribe first so there is an active session
		ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1" }));
		await waitForMs(50);

		// Send extension_ui_response from client
		ws.send(JSON.stringify({ type: "extension_ui_response", id: "req-1", value: "Option 1" }));
		await waitForMs(50);

		expect(pool.sendExtensionUIResponse).toHaveBeenCalledWith("s1", { id: "req-1", value: "Option 1" });

		ws.close();
	});

	// -------------------------------------------------------------------------
	// (b) no active session → receives error message
	// -------------------------------------------------------------------------
	it("(b) no active session → receives error message", async () => {
		const pool = createFakePool();

		server = createServer();
		wss = attachWsHandler(server, pool as unknown as import("../session-pool").SessionPool);

		await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
		const addr = server.address() as { port: number };

		const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
		await new Promise<void>((res) => ws.on("open", res));

		const received: unknown[] = [];
		ws.on("message", (data) => received.push(JSON.parse(data.toString())));

		// Send extension_ui_response without subscribing to any session
		ws.send(JSON.stringify({ type: "extension_ui_response", id: "req-1", value: "Option 1" }));
		await waitForMs(50);

		expect(received).toContainEqual({ type: "error", message: "No active session" });
		expect(pool.sendExtensionUIResponse).not.toHaveBeenCalled();

		ws.close();
	});

	// -------------------------------------------------------------------------
	// (c) missing id field → receives error message
	// -------------------------------------------------------------------------
	it("(c) missing id field → receives error message", async () => {
		const pool = createFakePool();

		server = createServer();
		wss = attachWsHandler(server, pool as unknown as import("../session-pool").SessionPool);

		await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
		const addr = server.address() as { port: number };

		const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
		await new Promise<void>((res) => ws.on("open", res));

		const received: unknown[] = [];
		ws.on("message", (data) => received.push(JSON.parse(data.toString())));

		// Subscribe first so there is an active session
		ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1" }));
		await waitForMs(50);

		// Send without id
		ws.send(JSON.stringify({ type: "extension_ui_response", value: "x" }));
		await waitForMs(50);

		expect(received).toContainEqual({ type: "error", message: "id is required" });
		expect(pool.sendExtensionUIResponse).not.toHaveBeenCalled();

		ws.close();
	});

	// -------------------------------------------------------------------------
	// (d) end-to-end round-trip: pool emits extension_ui_request → client receives
	//     session_event → client sends extension_ui_response → pool receives call
	// -------------------------------------------------------------------------
	it("(d) end-to-end round-trip", async () => {
		const pool = createFakePool();

		// Capture the listener registered on the pool's "event" emitter
		let eventListener: ((ev: unknown) => void) | null = null;
		pool._eventListeners.set("event", new Set());
		(pool as unknown as { on: (e: string, fn: (...a: unknown[]) => void) => void }).on = (
			event: string,
			fn: (...args: unknown[]) => void,
		) => {
			if (event === "event") {
				eventListener = fn as (...args: unknown[]) => void;
				pool._eventListeners.get(event)!.add(fn);
			}
		};

		server = createServer();
		wss = attachWsHandler(server, pool as unknown as import("../session-pool").SessionPool);

		await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
		const addr = server.address() as { port: number };

		const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
		await new Promise<void>((res) => ws.on("open", res));

		const received: unknown[] = [];
		ws.on("message", (data) => received.push(JSON.parse(data.toString())));

		// Subscribe to s1
		ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1" }));
		await waitForMs(50);

		// Simulate pool emitting an extension_ui_request event (as pi would)
		const piEvent = { type: "extension_ui_request", id: "req-1", question: "Which option?", options: ["A", "B"] };
		pool._emit("event", { sessionId: "s1", event: piEvent });
		await waitForMs(50);

		// Client should have received the session_event
		expect(received).toContainEqual({ type: "session_event", sessionId: "s1", event: piEvent });

		// Client sends back extension_ui_response
		ws.send(JSON.stringify({ type: "extension_ui_response", id: "req-1", value: "A" }));
		await waitForMs(50);

		// pool.sendExtensionUIResponse should have been called
		expect(pool.sendExtensionUIResponse).toHaveBeenCalledWith("s1", { id: "req-1", value: "A" });

		ws.close();
	});
});
