import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateProcessName, type ProcessEntry, ProcessRegistry } from "./process-registry.js";

let tempDir: string;
let registryPath: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "process-registry-test-"));
	registryPath = join(tempDir, "process-registry.jsonl");
});

afterEach(() => {
	if (existsSync(tempDir)) {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

function createRegistry(options?: { now?: () => number; pruneAgeMs?: number }) {
	return new ProcessRegistry({
		registryPath,
		pruneAgeMs: options?.pruneAgeMs,
		now: options?.now,
	});
}

// ── Test 1: Register a worker, query by name ─────────────────────────────────

describe("register + query", () => {
	it("registers a worker process and query by name returns entry with matching name, status=running", async () => {
		const registry = createRegistry();
		const entry = await registry.register({
			type: "worker",
			pid: 12345,
			name: "worker:build-check",
			sessionId: "abc123",
			sessionFile: "/path/to/session",
			verificationChecks: ["spec passes"],
		});

		expect(entry.processName).toBe("worker:build-check");
		expect(entry.status).toBe("running");
		expect(entry.type).toBe("worker");
		expect(entry.pid).toBe(12345);
		expect(entry.sessionId).toBe("abc123");
		expect(entry.verificationChecks).toEqual(["spec passes"]);

		const results = await registry.query({ name: "worker:build-check" });
		expect(results).toHaveLength(1);
		expect(results[0].processName).toBe("worker:build-check");
		expect(results[0].status).toBe("running");
	});

	it("queries by type and status", async () => {
		const registry = createRegistry();
		await registry.register({ type: "worker", pid: 100, name: "worker:a" });
		await registry.register({ type: "bash", pid: 101, name: "b:run" });
		await registry.register({ type: "worker", pid: 102, name: "worker:b" });

		const workers = await registry.query({ type: "worker" });
		expect(workers).toHaveLength(2);

		const running = await registry.query({ status: "running" });
		expect(running).toHaveLength(3);

		const runningWorkers = await registry.query({ type: "worker", status: "running" });
		expect(runningWorkers).toHaveLength(2);
	});
});

// ── Test 2: Name collision disambiguation ────────────────────────────────────

describe("name collision disambiguation", () => {
	it("registers two workers with same name context — second gets #2 suffix, both exist", async () => {
		const registry = createRegistry();

		const entry1 = await registry.register({ type: "worker", pid: 100, name: "worker:build" });
		const entry2 = await registry.register({ type: "worker", pid: 101, name: "worker:build" });

		expect(entry1.processName).toBe("worker:build");
		expect(entry2.processName).toBe("worker:build#2");

		const all = await registry.query();
		expect(all).toHaveLength(2);

		const first = await registry.getByName("worker:build");
		expect(first).toBeDefined();
		expect(first!.pid).toBe(100);

		const second = await registry.getByName("worker:build#2");
		expect(second).toBeDefined();
		expect(second!.pid).toBe(101);
	});

	it("increments beyond #2 when needed", async () => {
		const registry = createRegistry();

		const e1 = await registry.register({ type: "worker", pid: 100, name: "worker:test" });
		const e2 = await registry.register({ type: "worker", pid: 101, name: "worker:test" });
		const e3 = await registry.register({ type: "worker", pid: 102, name: "worker:test" });

		expect(e1.processName).toBe("worker:test");
		expect(e2.processName).toBe("worker:test#2");
		expect(e3.processName).toBe("worker:test#3");
	});
});

// ── Test 3: updateStatus removes entry from running query ─────────────────────

describe("updateStatus", () => {
	it("updateStatus to completed, query by status=running → entry no longer appears", async () => {
		const registry = createRegistry();

		await registry.register({ type: "worker", pid: 200, name: "worker:build-check" });

		const runningBefore = await registry.query({ status: "running" });
		expect(runningBefore).toHaveLength(1);

		const updated = await registry.updateStatus("worker:build-check", "completed", { exitCode: 0 });
		expect(updated.status).toBe("completed");
		expect(updated.exitCode).toBe(0);

		const runningAfter = await registry.query({ status: "running" });
		expect(runningAfter).toHaveLength(0);

		const completed = await registry.query({ status: "completed" });
		expect(completed).toHaveLength(1);
	});

	it("throws for unknown process name", async () => {
		const registry = createRegistry();
		await expect(registry.updateStatus("nonexistent", "completed")).rejects.toThrow("Process not found: nonexistent");
	});
});

// ── Test 4: reconcile marks dead PIDs as exited ──────────────────────────────

describe("reconcile", () => {
	it("kills a child process, call reconcile → entry status updated to exited", async () => {
		const registry = createRegistry();

		// Spawn a short-lived child process
		const { spawn } = await import("node:child_process");
		const child = spawn("node", ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
		const pid = child.pid!;

		await registry.register({ type: "worker", pid, name: "worker:long-task" });

		// Verify it's running
		const runningBefore = await registry.query({ status: "running" });
		expect(runningBefore).toHaveLength(1);

		// Kill the child
		child.kill("SIGKILL");
		// Wait for the process to actually exit
		await new Promise<void>((resolve) => {
			child.on("exit", () => resolve());
		});

		// Reconcile should detect the dead PID
		const updated = await registry.reconcile();
		expect(updated).toHaveLength(1);
		expect(updated[0].processName).toBe("worker:long-task");
		expect(updated[0].status).toBe("exited");

		// Verify the registry reflects the change
		const runningAfter = await registry.query({ status: "running" });
		expect(runningAfter).toHaveLength(0);

		const exited = await registry.query({ status: "exited" });
		expect(exited).toHaveLength(1);
	});

	it("skips terminal entries", async () => {
		const registry = createRegistry();

		await registry.register({ type: "worker", pid: 99999, name: "worker:already-done" });
		await registry.updateStatus("worker:already-done", "completed", { exitCode: 0 });

		const updated = await registry.reconcile();
		expect(updated).toHaveLength(0);
	});
});

// ── Test 5: Persistence across instances ─────────────────────────────────────

describe("persistence", () => {
	it("restart (new ProcessRegistry instance), query → previously registered entries still present from disk", async () => {
		// Instance 1: register entries
		const registry1 = createRegistry();
		await registry1.register({ type: "worker", pid: 300, name: "worker:persist-test" });
		await registry1.register({ type: "bash", pid: 301, name: "bash:npm-build" });

		// Instance 2: fresh instance, same path
		const registry2 = createRegistry();
		const all = await registry2.query();
		expect(all).toHaveLength(2);

		const worker = await registry2.getByName("worker:persist-test");
		expect(worker).toBeDefined();
		expect(worker!.pid).toBe(300);
		expect(worker!.status).toBe("running");

		const bashEntry = await registry2.getByName("bash:npm-build");
		expect(bashEntry).toBeDefined();
		expect(bashEntry!.type).toBe("bash");
	});
});

// ── Test 6: Prune completed entries ──────────────────────────────────────────

describe("prune", () => {
	it("prune removes terminal entries older than threshold, keeps running/pending", async () => {
		let clock = 1_000_000; // fixed base time
		const registry = createRegistry({
			now: () => clock,
			pruneAgeMs: 10_000,
		});

		// Register a worker and mark it completed at t=1_000_000
		await registry.register({ type: "worker", pid: 400, name: "worker:old-job" });
		await registry.updateStatus("worker:old-job", "completed", { exitCode: 0 });

		// Register a running worker at same time
		await registry.register({ type: "worker", pid: 401, name: "worker:active-job" });

		// Advance clock past prune threshold
		clock += 20_000;

		// Prune should remove the completed entry but keep the running one
		const pruned = await registry.prune();
		expect(pruned).toEqual(["worker:old-job"]);

		const remaining = await registry.query();
		expect(remaining).toHaveLength(1);
		expect(remaining[0].processName).toBe("worker:active-job");
	});

	it("does not prune recent terminal entries", async () => {
		let clock = 1_000_000;
		const registry = createRegistry({
			now: () => clock,
			pruneAgeMs: 10_000,
		});

		await registry.register({ type: "worker", pid: 500, name: "worker:recent-done" });
		await registry.updateStatus("worker:recent-done", "completed", { exitCode: 0 });

		// Only advance 5 seconds (within threshold)
		clock += 5_000;

		const pruned = await registry.prune();
		expect(pruned).toHaveLength(0);

		const remaining = await registry.query();
		expect(remaining).toHaveLength(1);
	});
});

// ── Corrupted lines handling ─────────────────────────────────────────────────

describe("corrupted JSONL lines", () => {
	it("skips corrupted lines silently without crashing", async () => {
		const { writeFileSync } = await import("node:fs");
		// Write some garbage + a valid entry
		writeFileSync(registryPath, "not-json\n{bad json\n");
		writeFileSync(registryPath, "", { flag: "a" }); // ensure file exists

		const registry = createRegistry();
		// Loading should not crash
		await registry.register({ type: "worker", pid: 600, name: "worker:after-corrupt" });

		const all = await registry.query();
		expect(all).toHaveLength(1);
		expect(all[0].processName).toBe("worker:after-corrupt");
	});
});

// ── generateProcessName ──────────────────────────────────────────────────────

describe("generateProcessName", () => {
	it("generates type:slug format", () => {
		expect(generateProcessName("worker", "build-check")).toBe("worker:build-check");
		expect(generateProcessName("bash", "npm test")).toBe("bash:npm-test");
		expect(generateProcessName("verifier", "  FOO BAR  ")).toBe("verifier:foo-bar");
	});

	it("truncates long slugs to 40 chars", () => {
		const long = "a".repeat(60);
		const result = generateProcessName("worker", long);
		// "worker:" is 7 chars, slug part should be 40
		expect(result).toBe(`worker:${"a".repeat(40)}`);
	});
});
