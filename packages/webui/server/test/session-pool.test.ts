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
		stdout: { on: ReturnType<typeof vi.fn> };
		stderr: { on: ReturnType<typeof vi.fn> };
		on: ReturnType<typeof vi.fn>;
		once: ReturnType<typeof vi.fn>;
		kill: ReturnType<typeof vi.fn>;
		pid: number;
		killed: boolean;
	};

	proc.stdin = { write: vi.fn(), end: vi.fn() };
	proc.stdout = { on: vi.fn() };
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
	// (n) kill is a no-op for unknown session
	// -------------------------------------------------------------------------
	it("(n) kill on unknown session does not throw", async () => {
		const pool = new SessionPool({ cwd: "/test" });
		await expect(pool.kill("ghost")).resolves.toBeUndefined();
	});

	// -------------------------------------------------------------------------
	// (o) init skips session files with non-session type header
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
