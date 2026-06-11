import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Per-test homedir override via module-level vi.mock
// ---------------------------------------------------------------------------
let currentTmpBase = "/tmp/pi-session-pool-test";

vi.mock("node:os", () => ({
	homedir: () => currentTmpBase,
}));

// ---------------------------------------------------------------------------
// Must be after vi.mock so the mock is in place
// ---------------------------------------------------------------------------
import { SessionPool } from "../session-pool";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Mock proc factory
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

describe("SessionPool", () => {
	const tmpBase = "/tmp/pi-session-pool-test";

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
	// (a) init loads N sessions from disk
	// -------------------------------------------------------------------------
	it("(a) init loads N sessions from disk", async () => {
		const sessionsDir = join(tmpBase, ".pi", "agent", "sessions", "--test--");
		await writeFile(
			join(sessionsDir, "session-a.jsonl"),
			JSON.stringify({
				type: "session",
				id: "session-a",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: "/test",
			}) + "\n",
		);
		await writeFile(
			join(sessionsDir, "session-b.jsonl"),
			JSON.stringify({
				type: "session",
				id: "session-b",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: "/test",
			}) + "\n",
		);
		await writeFile(
			join(sessionsDir, "session-c.jsonl"),
			JSON.stringify({
				type: "session",
				id: "session-c",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: "/test",
			}) + "\n",
		);

		const pool = new SessionPool({ cwd: "/test" });
		const ids = await pool.init();

		expect(ids).toHaveLength(3);
		expect(ids).toContain("session-a");
		expect(ids).toContain("session-b");
		expect(ids).toContain("session-c");
	});

	// -------------------------------------------------------------------------
	// (b) spawnIfNeeded is idempotent
	// -------------------------------------------------------------------------
	it("(b) spawnIfNeeded is idempotent", async () => {
		const { proc } = makeMockProc();
		proc.once.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
			if (event === "exit") setTimeout(() => cb(0, null), 0);
			return proc;
		});

		let spawnCallCount = 0;
		const pool = new SessionPool({
			cwd: "/test",
			spawnFn: () => {
				spawnCallCount++;
				return proc;
			},
		});

		await pool.spawnIfNeeded("s1");
		await pool.spawnIfNeeded("s1");

		expect(spawnCallCount).toBe(1);
	});

	// -------------------------------------------------------------------------
	// (c) broadcast forwards events to subscribers
	// -------------------------------------------------------------------------
	it("(c) broadcast forwards events to subscribers", async () => {
		const { proc } = makeMockProc();
		proc.once.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
			if (event === "exit") setTimeout(() => cb(0, null), 0);
			return proc;
		});

		const sendMock = vi.fn();
		const pool = new SessionPool({ cwd: "/test", spawnFn: () => proc });

		await pool.spawnIfNeeded("s1");
		pool.subscribe("s1", { send: sendMock });
		pool.broadcast("s1", { foo: 1 });

		expect(sendMock).toHaveBeenCalledOnce();
		expect(sendMock).toHaveBeenCalledWith(JSON.stringify({ foo: 1 }));
	});

	// -------------------------------------------------------------------------
	// (d) kill sends SIGTERM
	// -------------------------------------------------------------------------
	it("(d) kill sends SIGTERM", async () => {
		vi.useFakeTimers();

		const { proc } = makeMockProc();
		proc.once.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
			if (event === "exit") setTimeout(() => cb(0, null), 0);
			return proc;
		});

		const pool = new SessionPool({ cwd: "/test", spawnFn: () => proc });

		await pool.spawnIfNeeded("s1");
		const killPromise = pool.kill("s1");

		// Advance past the 5s SIGKILL threshold
		vi.advanceTimersByTime(6000);
		await killPromise;

		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		vi.useRealTimers();
	});

	// -------------------------------------------------------------------------
	// (e) cleanupOnExit kills all
	// -------------------------------------------------------------------------
	it("(e) cleanupOnExit kills all", async () => {
		const { proc: proc1 } = makeMockProc();
		const { proc: proc2 } = makeMockProc();
		const spawns = [proc1, proc2];
		let idx = 0;
		const pool = new SessionPool({ cwd: "/test", spawnFn: () => spawns[idx++] });

		await pool.spawnIfNeeded("s1");
		await pool.spawnIfNeeded("s2");

		pool.cleanupOnExit();

		expect(proc1.kill).toHaveBeenCalledWith("SIGTERM");
		expect(proc2.kill).toHaveBeenCalledWith("SIGTERM");
	});

	// -------------------------------------------------------------------------
	// (f) unsubscribe removes subscriber
	// -------------------------------------------------------------------------
	it("(f) unsubscribe removes subscriber", async () => {
		const { proc } = makeMockProc();
		proc.once.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
			if (event === "exit") setTimeout(() => cb(0, null), 0);
			return proc;
		});

		const sendMock1 = vi.fn();
		const sendMock2 = vi.fn();
		const client1 = { send: sendMock1 };
		const client2 = { send: sendMock2 };
		const pool = new SessionPool({ cwd: "/test", spawnFn: () => proc });

		await pool.spawnIfNeeded("s1");
		pool.subscribe("s1", client1);
		pool.subscribe("s1", client2);
		pool.broadcast("s1", { msg: "first" });
		expect(sendMock1).toHaveBeenCalledTimes(1);
		expect(sendMock2).toHaveBeenCalledTimes(1);

		pool.unsubscribe("s1", client1);
		pool.broadcast("s1", { msg: "second" });
		expect(sendMock1).toHaveBeenCalledTimes(1); // not called again
		expect(sendMock2).toHaveBeenCalledTimes(2);
	});

	// -------------------------------------------------------------------------
	// (g) isRunning and size
	// -------------------------------------------------------------------------
	it("(g) isRunning and size reflect session state", async () => {
		const { proc } = makeMockProc();
		proc.once.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
			if (event === "exit") setTimeout(() => cb(0, null), 0);
			return proc;
		});

		const pool = new SessionPool({ cwd: "/test", spawnFn: () => proc });

		expect(pool.size).toBe(0);
		expect(pool.isRunning("s1")).toBe(false);

		await pool.spawnIfNeeded("s1");
		expect(pool.size).toBe(1);
		expect(pool.isRunning("s1")).toBe(true);
		expect(pool.isRunning("s2")).toBe(false);

		await pool.spawnIfNeeded("s2");
		expect(pool.size).toBe(2);
	});

	// -------------------------------------------------------------------------
	// (h) broadcast to non-existent session is no-op (no throw)
	// -------------------------------------------------------------------------
	it("(h) broadcast to non-existent session does not throw", () => {
		const pool = new SessionPool({ cwd: "/test" });
		expect(() => pool.broadcast("does-not-exist", { foo: 1 })).not.toThrow();
	});

	// -------------------------------------------------------------------------
	// (i) init with non-existent directory returns empty array
	// -------------------------------------------------------------------------
	it("(i) init with non-existent directory returns empty array", async () => {
		await rm(tmpBase, { recursive: true, force: true });
		const pool = new SessionPool({ cwd: "/test" });
		const ids = await pool.init();
		expect(ids).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// (j) init skips non-.jsonl files
	// -------------------------------------------------------------------------
	it("(j) init skips non-.jsonl files", async () => {
		const sessionsDir = join(tmpBase, ".pi", "agent", "sessions", "--test--");
		await writeFile(join(sessionsDir, "readme.txt"), "not a session");
		await writeFile(
			join(sessionsDir, "session-a.jsonl"),
			JSON.stringify({
				type: "session",
				id: "session-a",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: "/test",
			}) + "\n",
		);

		const pool = new SessionPool({ cwd: "/test" });
		const ids = await pool.init();

		expect(ids).toHaveLength(1);
		expect(ids).toContain("session-a");
	});

	// -------------------------------------------------------------------------
	// (k) spawnIfNeeded throws when max sessions reached
	// -------------------------------------------------------------------------
	it("(k) spawnIfNeeded throws when max sessions reached", async () => {
		const { proc } = makeMockProc();
		const pool = new SessionPool({ cwd: "/test", spawnFn: () => proc, maxSessions: 1 });

		await pool.spawnIfNeeded("s1");
		await expect(pool.spawnIfNeeded("s2")).rejects.toThrow("Max sessions");
	});

	// -------------------------------------------------------------------------
	// (l) broadcast with multiple subscribers
	// -------------------------------------------------------------------------
	it("(l) broadcast forwards to all subscribers", async () => {
		const { proc } = makeMockProc();
		proc.once.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
			if (event === "exit") setTimeout(() => cb(0, null), 0);
			return proc;
		});

		const sendA = vi.fn();
		const sendB = vi.fn();
		const pool = new SessionPool({ cwd: "/test", spawnFn: () => proc });

		await pool.spawnIfNeeded("s1");
		pool.subscribe("s1", { send: sendA });
		pool.subscribe("s1", { send: sendB });
		pool.broadcast("s1", { event: "test" });

		expect(sendA).toHaveBeenCalledOnce();
		expect(sendB).toHaveBeenCalledOnce();
		expect(sendA).toHaveBeenCalledWith(JSON.stringify({ event: "test" }));
		expect(sendB).toHaveBeenCalledWith(JSON.stringify({ event: "test" }));
	});

	// -------------------------------------------------------------------------
	// (m) stdout data triggers pool event emission
	// -------------------------------------------------------------------------
	it("(m) stdout JSON-line data emits pool event", async () => {
		const { proc } = makeMockProc();
		proc.once.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
			if (event === "exit") setTimeout(() => cb(0, null), 0);
			return proc;
		});

		const eventSpy = vi.fn();
		const pool = new SessionPool({ cwd: "/test", spawnFn: () => proc });
		pool.on("event", eventSpy);

		await pool.spawnIfNeeded("s1");

		// Simulate JSON-line stdout output
		const dataCalls = proc.stdout.on.mock.calls.filter((c) => c[0] === "data");
		expect(dataCalls.length).toBeGreaterThan(0);
		const dataHandler = dataCalls[0][1];
		dataHandler(Buffer.from(JSON.stringify({ type: "chunk", content: "hello" }) + "\n"));

		expect(eventSpy).toHaveBeenCalledOnce();
		expect(eventSpy).toHaveBeenCalledWith({
			sessionId: "s1",
			event: { type: "chunk", content: "hello" },
		});
	});

	// -------------------------------------------------------------------------
	// (m2) stdout data that spans multiple chunks is reassembled before
	// JSON.parse — Node's `data` event does NOT guarantee line-aligned chunks,
	// so a single JSON line from pi can arrive in 2+ pieces. The previous
	// implementation split each chunk independently and silently dropped
	// any line whose JSON failed to parse, which dropped the streaming
	// events the webui needs to render the assistant's reply in real time
	// (the page stayed blank until the 3-second polling fallback caught up).
	// -------------------------------------------------------------------------
	it("(m2) stdout data spanning multiple chunks reassembles into one event", async () => {
		const { proc } = makeMockProc();
		proc.once.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
			if (event === "exit") setTimeout(() => cb(0, null), 0);
			return proc;
		});

		const eventSpy = vi.fn();
		const pool = new SessionPool({ cwd: "/test", spawnFn: () => proc });
		pool.on("event", eventSpy);

		await pool.spawnIfNeeded("s1");

		// Build a realistic, multi-KB JSON line like pi emits for a streaming
		// assistant message (with thinking + text). 8 KB comfortably exceeds a
		// single Node pipe chunk, so it's almost guaranteed to be split.
		const bigLine =
			JSON.stringify({
				type: "message_update",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "x".repeat(4000) },
						{ type: "text", text: "y".repeat(2000) },
					],
				},
			}) + "\n";
		expect(bigLine.length).toBeGreaterThan(4096);

		// Split at an arbitrary point in the middle of the JSON.
		const splitAt = 1234;
		const chunk1 = Buffer.from(bigLine.slice(0, splitAt));
		const chunk2 = Buffer.from(bigLine.slice(splitAt));

		const dataCalls = proc.stdout.on.mock.calls.filter((c) => c[0] === "data");
		expect(dataCalls.length).toBeGreaterThan(0);
		const dataHandler = dataCalls[0][1];

		// Feed the two chunks as Node would deliver them. Must reassemble into
		// exactly one emitted event.
		dataHandler(chunk1);
		dataHandler(chunk2);

		const updateCalls = eventSpy.mock.calls.filter(
			(call) => (call[0] as { event?: { type?: string } }).event?.type === "message_update",
		);
		expect(updateCalls).toHaveLength(1);
	});

	// -------------------------------------------------------------------------
	// (o) proc exit while isResponding emits session_status_changed("idle")
	//
	// Bug 2: if pi exits mid-turn (crash/kill), proc.on("exit") deletes the
	// session without emitting "idle". The client never transitions from
	// "running" to "idle" — the Stop button stays visible.
	// -------------------------------------------------------------------------
	it("(o) proc exit while isResponding emits session_status_changed(idle)", async () => {
		const { proc } = makeMockProc();
		// Do NOT mock "exit" to auto-fire (we control the timing)
		proc.once.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
			if (event === "exit") return proc;
			return proc;
		});

		const eventSpy = vi.fn();
		const pool = new SessionPool({ cwd: "/test", spawnFn: () => proc });
		pool.on("event", eventSpy);

		await pool.spawnIfNeeded("s1");

		// Simulate the prompt() path: isResponding is set to true
		const state = (pool as unknown as { sessions: Map<string, { isResponding: boolean }> }).sessions.get("s1");
		state!.isResponding = true;

		// Simulate pi process exiting while isResponding is true
		const exitCalls = proc.on.mock.calls.filter((c) => c[0] === "exit");
		expect(exitCalls.length).toBeGreaterThan(0);
		const exitHandler = exitCalls[0][1];
		exitHandler(1, null);

		// Must emit session_status_changed("idle") so the client transitions
		expect(eventSpy).toHaveBeenCalledWith({
			sessionId: "s1",
			event: { type: "session_status_changed", status: "idle" },
		});
	});

	// -------------------------------------------------------------------------
	// (p) proc exit when NOT isResponding does NOT emit idle (already emitted)
	// -------------------------------------------------------------------------
	it("(p) proc exit when not isResponding does not duplicate idle emission", async () => {
		const { proc } = makeMockProc();
		proc.once.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
			if (event === "exit") return proc;
			return proc;
		});

		const eventSpy = vi.fn();
		const pool = new SessionPool({ cwd: "/test", spawnFn: () => proc });
		pool.on("event", eventSpy);

		await pool.spawnIfNeeded("s1");

		// isResponding is false (natural end: agent_end already fired and cleared it)
		const state = (pool as unknown as { sessions: Map<string, { isResponding: boolean }> }).sessions.get("s1");
		state!.isResponding = false;

		// Simulate pi process exiting after natural completion
		const exitCalls = proc.on.mock.calls.filter((c) => c[0] === "exit");
		const exitHandler = exitCalls[0][1];
		exitHandler(0, null);

		// Must NOT emit session_status_changed("idle") — already emitted by agent_end
		const idleCalls = eventSpy.mock.calls.filter(
			(call) =>
				call[0] &&
				(call[0] as { event?: { type: string; status?: string } }).event?.type ===
					"session_status_changed" &&
				(call[0] as { event?: { type: string; status?: string } }).event?.status === "idle",
		);
		expect(idleCalls).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// (n) kill is a no-op for unknown session
	// -------------------------------------------------------------------------
	it("(n) kill on unknown session does not throw", async () => {
		const pool = new SessionPool({ cwd: "/test" });
		await expect(pool.kill("ghost")).resolves.toBeUndefined();
	});

	// -------------------------------------------------------------------------
	// (p) prompt writes content[] array with text part (no images) + legacy message field
	// -------------------------------------------------------------------------
	it("(p) prompt writes content[] array with text part to stdin", async () => {
		const { proc } = makeMockProc();
		proc.once.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
			if (event === "exit") setTimeout(() => cb(0, null), 0);
			return proc;
		});

		const pool = new SessionPool({ cwd: "/test", spawnFn: () => proc });
		await pool.spawnIfNeeded("s1");
		await pool.prompt("s1", "hello", []);

		expect(proc.stdin.write).toHaveBeenCalledOnce();
		const written = proc.stdin.write.mock.calls[0][0] as string;
		const parsed = JSON.parse(written.trim());

		expect(parsed).toEqual({
			type: "prompt",
			sessionId: "s1",
			content: [{ type: "text", text: "hello" }],
			message: "hello",
		});
		// Ensure the legacy `text` field is NOT present at top level
		expect(parsed).not.toHaveProperty("text");
	});

	// -------------------------------------------------------------------------
	// setSessionName
	// -------------------------------------------------------------------------

	it("(q) setSessionName resolves on success response", async () => {
		const { proc } = makeMockProc();
		proc.once.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
			if (event === "exit") setTimeout(() => cb(0, null), 0);
			return proc;
		});

		const pool = new SessionPool({ cwd: "/test", spawnFn: () => proc });
		await pool.spawnIfNeeded("s1");

		// Intercept stdout.on to capture the setSessionName handler
		let setSessionOnData: ((chunk: Buffer | string) => void) | null = null;
		const origStdoutOn = proc.stdout.on;
		proc.stdout.on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			if (event === "data") setSessionOnData = handler as (chunk: Buffer | string) => void;
			return origStdoutOn.call(proc.stdout, event, handler);
		});

		// Capture corrId from the write
		let writtenCorrId: string | null = null;
		const origWrite = proc.stdin.write;
		proc.stdin.write = vi.fn((msg: string) => {
			const parsed = JSON.parse(msg.trim());
			if (parsed.type === "set_session_name") {
				writtenCorrId = parsed.id;
			}
			return origWrite.call(proc.stdin, msg);
		});

		const setSessionNamePromise = pool.setSessionName("s1", "MyTitle");

		// Emit success response via the captured setSessionName handler
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(writtenCorrId).toBeTruthy();
		expect(setSessionOnData).not.toBeNull();
		setSessionOnData!(Buffer.from(JSON.stringify({ type: "response", command: "set_session_name", id: writtenCorrId, success: true }) + "\n"));

		await expect(setSessionNamePromise).resolves.toBeUndefined();
	});

	it("(r) setSessionName rejects on failure response", async () => {
		const { proc } = makeMockProc();
		proc.once.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
			if (event === "exit") setTimeout(() => cb(0, null), 0);
			return proc;
		});

		const pool = new SessionPool({ cwd: "/test", spawnFn: () => proc });
		await pool.spawnIfNeeded("s1");

		let setSessionOnData: ((chunk: Buffer | string) => void) | null = null;
		const origStdoutOn = proc.stdout.on;
		proc.stdout.on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			if (event === "data") setSessionOnData = handler as (chunk: Buffer | string) => void;
			return origStdoutOn.call(proc.stdout, event, handler);
		});

		let writtenCorrId: string | null = null;
		const origWrite = proc.stdin.write;
		proc.stdin.write = vi.fn((msg: string) => {
			const parsed = JSON.parse(msg.trim());
			if (parsed.type === "set_session_name") {
				writtenCorrId = parsed.id;
			}
			return origWrite.call(proc.stdin, msg);
		});

		const setSessionNamePromise = pool.setSessionName("s1", "MyTitle");

		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(writtenCorrId).toBeTruthy();
		expect(setSessionOnData).not.toBeNull();

		// Emit failure response
		setSessionOnData!(Buffer.from(JSON.stringify({ type: "response", command: "set_session_name", id: writtenCorrId, success: false, error: "boom" }) + "\n"));

		await expect(setSessionNamePromise).rejects.toThrow("boom");
	});

	it("(s) setSessionName rejects on timeout after 5s", async () => {
		const { proc } = makeMockProc();
		proc.once.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
			if (event === "exit") setTimeout(() => cb(0, null), 0);
			return proc;
		});

		const pool = new SessionPool({ cwd: "/test", spawnFn: () => proc });
		await pool.spawnIfNeeded("s1");

		const setSessionNamePromise = pool.setSessionName("s1", "MyTitle");

		// Wait just over 5 seconds to allow the internal timeout to fire
		// Use a single await to catch the rejection synchronously before unhandled-rejection tracking
		await expect(Promise.race([
			setSessionNamePromise,
			new Promise<void>((_, reject) => setTimeout(() => reject(new Error("wait exceeded")), 5100)),
		])).rejects.toThrow("timed out");
	}, 10000);

	it("(t) setSessionName is idempotent — second call returns early without writing", async () => {
		const { proc } = makeMockProc();
		proc.once.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
			if (event === "exit") setTimeout(() => cb(0, null), 0);
			return proc;
		});

		const pool = new SessionPool({ cwd: "/test", spawnFn: () => proc });
		await pool.spawnIfNeeded("s1");

		let setSessionOnData: ((chunk: Buffer | string) => void) | null = null;
		const origStdoutOn = proc.stdout.on;
		proc.stdout.on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			if (event === "data") setSessionOnData = handler as (chunk: Buffer | string) => void;
			return origStdoutOn.call(proc.stdout, event, handler);
		});

		let writtenCorrId: string | null = null;
		const origWrite = proc.stdin.write;
		proc.stdin.write = vi.fn((msg: string) => {
			const parsed = JSON.parse(msg.trim());
			if (parsed.type === "set_session_name") {
				writtenCorrId = parsed.id;
			}
			return origWrite.call(proc.stdin, msg);
		});

		// First call — resolve with success
		const p1 = pool.setSessionName("s1", "MyTitle");
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(writtenCorrId).toBeTruthy();
		expect(setSessionOnData).not.toBeNull();
		setSessionOnData!(Buffer.from(JSON.stringify({ type: "response", command: "set_session_name", id: writtenCorrId, success: true }) + "\n"));
		await p1;

		// Second call — should return early, no new write
		const writeCountBefore = (proc.stdin.write as ReturnType<typeof vi.fn>).mock.calls.length;
		const p2 = pool.setSessionName("s1", "MyTitle");
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		// stdin.write should NOT have been called again (idempotent)
		const writeCountAfter = (proc.stdin.write as ReturnType<typeof vi.fn>).mock.calls.length;
		expect(writeCountAfter).toBe(writeCountBefore);
		await p2; // should resolve immediately (no async work)

		// Verify titlesSeen was populated
		expect(pool.getTitlesSeen("s1")).toBeDefined();
		expect(pool.getTitlesSeen("s1")?.has("s1")).toBe(true);
	});

	// -------------------------------------------------------------------------
	// (u) spawnIfNeeded passes full file path to --session (not just sessionId)
	// -------------------------------------------------------------------------
	it("(u) spawnIfNeeded passes full file path to --session to avoid fork prompt", async () => {
		const { proc } = makeMockProc();
		proc.once.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
			if (event === "exit") setTimeout(() => cb(0, null), 0);
			return proc;
		});

		// Create a session file that matches the sessionId so findSessionFile can find it
		const sessionsDir = join(tmpBase, ".pi", "agent", "sessions", "--test--");
		await writeFile(
			join(sessionsDir, "2026-06-02T04-18-22-483Z_my-session-id.jsonl"),
			JSON.stringify({
				type: "session",
				id: "my-session-id",
				timestamp: "2026-06-02T04:18:22.483Z",
				cwd: "/test",
			}) + "\n",
		);

		let spawnArgs: string[] = [];
		const pool = new SessionPool({
			cwd: "/test",
			spawnFn: (_cmd, args, _opts) => {
				spawnArgs = args;
				return proc;
			},
		});

		await pool.spawnIfNeeded("my-session-id");

		// spawnFn should have been called
		expect(spawnArgs.length).toBeGreaterThan(0);

		// Find --session argument index
		const sessionIdx = spawnArgs.indexOf("--session");
		expect(sessionIdx).toBeGreaterThanOrEqual(0);

		const sessionArg = spawnArgs[sessionIdx + 1];
		// Must contain "/" or end with ".jsonl" to be recognized as a path by pi's resolveSessionPath
		expect(sessionArg).toSatisfy(
			(val: string) => val.includes("/") || val.endsWith(".jsonl"),
			`--session argument must be a full path, got: ${sessionArg}`,
		);
		// Should contain the sessionId somewhere in the filename
		expect(sessionArg).toContain("my-session-id");
	});

	// -------------------------------------------------------------------------
	// getSessionName
	// -------------------------------------------------------------------------

	it("getSessionName returns undefined for unknown session", () => {
		const pool = new SessionPool({ cwd: "/test" });
		expect(pool.getSessionName("nonexistent")).toBeUndefined();
	});

	it("sessionNames map is empty initially", () => {
		const pool = new SessionPool({ cwd: "/test" });
		expect(pool.getSessionName("any-id")).toBeUndefined();
	});

	it("getSessionName returns name set via session_info_changed event", async () => {
		const { proc } = makeMockProc();
		proc.once.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
			if (event === "exit") setTimeout(() => cb(0, null), 0);
			return proc;
		});

		const pool = new SessionPool({ cwd: "/test", spawnFn: () => proc });
		await pool.spawnIfNeeded("s1");

		// Get the stdout data handler
		const dataCalls = proc.stdout.on.mock.calls.filter((c) => c[0] === "data");
		expect(dataCalls.length).toBeGreaterThan(0);
		const dataHandler = dataCalls[0][1];

		// Emit a session_info_changed event
		dataHandler(Buffer.from(JSON.stringify({ type: "session_info_changed", name: "MySessionTitle" }) + "\n"));

		// getSessionName should now return the name
		expect(pool.getSessionName("s1")).toBe("MySessionTitle");
	});

	// -------------------------------------------------------------------------
	// sessionsDir encoding must match pi core's getDefaultSessionDirPath
	// -------------------------------------------------------------------------

	it("sessionsDir uses single-dash encoding (matches pi core)", () => {
		// For cwd /home/qjh/.pi/agent:
		// pi core produces: --home-qjh-.pi-agent--
		// NOT webui's buggy double-dash: --home--qjh--.pi--agent--
		const pool = new SessionPool({ cwd: "/home/qjh/.pi/agent" });
		expect(pool.sessionsDir).toMatch(/--home-qjh-\.pi-agent--$/);
	});

	it("sessionsDir escapes colons with single dash (matches pi core)", () => {
		// pi core escapes colons to single dash: --foo-bar-baz--
		// webui's buggy encoding would not handle : at all
		const pool = new SessionPool({ cwd: "/foo:bar/baz" });
		expect(pool.sessionsDir).toMatch(/--foo-bar-baz--$/);
	});

	it("sessionsDir uses pi core's path-safe encoding for root cwd", () => {
		// Root cwd / should produce ---- (empty segments, double dash wrapper)
		const pool = new SessionPool({ cwd: "/" });
		expect(pool.sessionsDir).toMatch(/----$/);
	});

	// -------------------------------------------------------------------------
	// (v) prompt writes content[] array with text and image parts to stdin
	// -------------------------------------------------------------------------
	it("(v) prompt writes content[] array with text and image parts to stdin", async () => {
		const { proc } = makeMockProc();
		proc.once.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
			if (event === "exit") setTimeout(() => cb(0, null), 0);
			return proc;
		});

		const pool = new SessionPool({ cwd: "/test", spawnFn: () => proc });
		await pool.spawnIfNeeded("s1");

		const images = [
			{ mediaType: "image/png", data: "abc123" },
			{ mediaType: "image/jpeg", data: "def456" },
		];
		await pool.prompt("s1", "hello world", images);

		expect(proc.stdin.write).toHaveBeenCalledOnce();
		const written = proc.stdin.write.mock.calls[0][0] as string;
		const parsed = JSON.parse(written.trim());

		// content array must be present with text part first
		expect(parsed.content).toEqual([
			{ type: "text", text: "hello world" },
			{ type: "image", mediaType: "image/png", data: "abc123" },
			{ type: "image", mediaType: "image/jpeg", data: "def456" },
		]);
		// legacy message field for backward compatibility
		expect(parsed.message).toBe("hello world");
		// type and sessionId
		expect(parsed.type).toBe("prompt");
		expect(parsed.sessionId).toBe("s1");
	});

	// -------------------------------------------------------------------------
	// (o) init skips session files with wrong type header
	// -------------------------------------------------------------------------

	it("(o) init skips session files with wrong type header", async () => {
		const sessionsDir = join(tmpBase, ".pi", "agent", "sessions", "--test--");
		await writeFile(
			join(sessionsDir, "not-a-session.jsonl"),
			JSON.stringify({
				type: "not-a-session",
				id: "should-skip",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: "/test",
			}) + "\n",
		);

		const pool = new SessionPool({ cwd: "/test" });
		const ids = await pool.init();

		expect(ids).toHaveLength(0);
	});
});
