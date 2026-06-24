// Regression: createApp() in production boot path must pass dbPath/atomsDir to
// mountSessionsRoutes, otherwise DELETE /api/sessions/:id silently loses
// memories (dirname(undefined) throws inside MemoryIndex, caught by
// extractAtomsSafely which logs a warning and proceeds with deletion).
//
// Symptom that motivated this test: production server printed
//   "Memory extraction failed, proceeding with deletion:
//    TypeError [ERR_INVALID_ARG_TYPE]: The 'path' argument must be of
//    type string. Received undefined
//      at dirname (node:path:1442:5)
//      at new MemoryIndex (...server.bundle.js:140607:21)
//      at runMemoryExtraction (...)"
// on every DELETE. Atoms were silently dropped; only the warning was visible.
//
// Root cause: mountSessionsRoutes was called with {callLlm, settings} only.
// The deps.dbPath/atomsDir were undefined, and extractAtomsSafely passed
// them straight through to runMemoryExtraction → new MemoryIndex(undefined).
//
// Fix: server boot now derives dbPath/atomsDir from settings.memory.* with
// DEFAULT_DB_PATH/DEFAULT_ATOMS_DIR fallbacks, exports them from
// @earendil-works/pi-personal-assistant, and passes them in mountSessionsRoutes.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";

const TEST_PORT = 18782;

describe("createApp() passes dbPath/atomsDir to mountSessionsRoutes", () => {
	let runMemoryExtractionSpy: any;
	let tempSessionsDir: string;
	let tempDbPath: string;
	let tempAtomsDir: string;
	let server: Server;
	let app: express.Express;

	beforeEach(async () => {
		// Spy on runMemoryExtraction — captures the actual dbPath/atomsDir
		// passed from createApp()'s mountSessionsRoutes through
		// extractAtomsSafely.
		const paModule = await import("@earendil-works/pi-personal-assistant");
		runMemoryExtractionSpy = vi.spyOn(paModule, "runMemoryExtraction");
		runMemoryExtractionSpy.mockResolvedValue({
			plan: {
				items: [],
				modelUsed: "test/test",
				generatedAt: Date.now(),
			},
			atomsWritten: 0,
			created: [],
			superseded: [],
			skipped: [],
		});

		// Set up temp dirs. Settings file goes under ~/.pi/agent so the
		// webui server's loadSettings() finds it. We use a HOME override
		// via a tiny stub settings file to keep test isolated.
		const testId = crypto.randomUUID();
		tempSessionsDir = path.join("/tmp", `pi-createapp-sessions-${testId}`);
		tempDbPath = path.join("/tmp", `pi-createapp-${testId}`, "memory.db");
		tempAtomsDir = path.join("/tmp", `pi-createapp-${testId}`, "atoms");
		await fs.mkdir(tempSessionsDir, { recursive: true });
		await fs.mkdir(path.dirname(tempDbPath), { recursive: true });
		await fs.mkdir(tempAtomsDir, { recursive: true });

		// We point the webui at our temp paths via the server-deps injection
		// path, NOT via the real loadSettings(). createApp() takes Partial<ServerDeps>,
		// and our fix derived dbPath from settings.memory.dbPath, so we set it
		// in the settings object we hand in.
		const { createApp } = await import("../../index.ts");
		const { SessionPool } = await import("../../session-pool.ts");
		const { CronStore } = await import("../../cron-store.ts");
		const { CronWatcher } = await import("../../cron-watcher.ts");

		const sessionPool = new SessionPool();
		Object.defineProperty(sessionPool, "sessionsDir", {
			value: tempSessionsDir,
			writable: false,
		});
		const cronStore = new CronStore();
		// CronWatcher just needs a path string; we mirror what index.ts does
		// internally so we don't reach into the private dataPath getter.
		const fakeCronDataPath = path.join(path.dirname(tempDbPath), "cron.json");
		const cronWatcher = new CronWatcher(fakeCronDataPath);

		const result = createApp({
			sessionPool,
			cronStore,
			cronWatcher,
			callLlm: vi.fn(async () => '{"items":[]}'),
			settings: {
				memory: {
					dbPath: tempDbPath,
					atomsDir: tempAtomsDir,
				},
			},
		});
		app = result.app;
		server = createServer(app);
		await new Promise<void>((resolve) => server.listen(TEST_PORT, "127.0.0.1", resolve));
	});

	afterEach(async () => {
		if (server?.listening) {
			await new Promise<void>((resolve, reject) =>
				server.close((err) => (err ? reject(err) : resolve())),
			);
		}
		runMemoryExtractionSpy?.mockRestore();
		// Clean up
		try {
			await fs.rm(path.dirname(tempDbPath), { recursive: true, force: true });
			await fs.rm(tempSessionsDir, { recursive: true, force: true });
		} catch {}
	});

	it("DELETE /api/sessions/:id invokes runMemoryExtraction with a string dbPath (not undefined)", async () => {
		// Create a real session file in tempSessionsDir
		const sessionId = "test-session-" + crypto.randomUUID();
		const sessionFile = path.join(tempSessionsDir, `${sessionId}.jsonl`);
		// Minimal JSONL: header + one user/assistant pair
		const content =
			JSON.stringify({ type: "session", id: sessionId, timestamp: 0 }) +
			"\n" +
			JSON.stringify({
				type: "message",
				message: { role: "user", content: "hello", timestamp: 0 },
			}) +
			"\n" +
			JSON.stringify({
				type: "message",
				message: { role: "assistant", content: "hi back", timestamp: 1 },
			}) +
			"\n";
		await fs.writeFile(sessionFile, content, "utf-8");

		const addr = server.address() as AddressInfo;
		const res = await fetch(`http://127.0.0.1:${addr.port}/api/sessions/${sessionId}`, {
			method: "DELETE",
		});
		// DELETE returns immediately; extraction runs in background.
		// Wait a bit for the fire-and-forget call to flush.
		await new Promise((r) => setTimeout(r, 300));

		expect(res.status).toBe(200);
		expect(runMemoryExtractionSpy).toHaveBeenCalled();
		const callArg = runMemoryExtractionSpy.mock.calls[0]?.[0] as
			| { dbPath?: string; atomsDir?: string }
			| undefined;
		expect(callArg).toBeDefined();
		// THIS is the regression: dbPath and atomsDir must be non-empty strings.
		// Pre-fix, they were undefined and MemoryIndex(undefined) crashed.
		expect(typeof callArg?.dbPath).toBe("string");
		expect(callArg?.dbPath?.length).toBeGreaterThan(0);
		expect(typeof callArg?.atomsDir).toBe("string");
		expect(callArg?.atomsDir?.length).toBeGreaterThan(0);
		// And they should resolve to the paths we put in settings.
		expect(callArg?.dbPath).toBe(tempDbPath);
		expect(callArg?.atomsDir).toBe(tempAtomsDir);
	});
});
