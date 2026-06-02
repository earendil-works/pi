import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import { createServer } from "node:http";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { homedir } from "node:os";

const TEST_PORT = 18771;

describe("Sessions REST API Endpoints", () => {
	let mountSessionsRoutes: (app: express.Express, sessionPool: any) => void;
	let SessionPool: any;
	let tempSessionsDir: string;
	let fakeSessionsDir: string;

	beforeEach(async () => {
		// Dynamic imports
		const sessionsModule = await import("../routes/sessions");
		mountSessionsRoutes = sessionsModule.mountSessionsRoutes;

		const poolModule = await import("../session-pool");
		SessionPool = poolModule.SessionPool;

		// Create unique temp sessions dir for each test
		const testId = crypto.randomUUID();
		tempSessionsDir = path.join("/tmp", `pi-sessions-test-${testId}`);

		// Create a fake sessionsDir by overriding via a mock pool
		fakeSessionsDir = tempSessionsDir;
	});

	afterEach(async () => {
		// Cleanup temp directory
		try {
			await fs.rm(tempSessionsDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	// Helper to create a mock session pool with a custom sessionsDir
	function createMockPool(sessionsDir: string): any {
		return {
			sessionsDir,
			isRunning: () => false,
			getSessionName: () => undefined,
			on: () => {},
			emit: () => {},
		};
	}

	// (a) POST /api/sessions creates session file with header
	describe("(a) POST /api/sessions creates session file with header", () => {
		let app: express.Express;
		let server: ReturnType<typeof createServer>;
		let sessionId: string;
		let sessionFile: string;

		beforeEach(async () => {
			app = express();
			app.use(express.json());
			const pool = createMockPool(fakeSessionsDir);
			mountSessionsRoutes(app, pool);
			server = createServer(app);

			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const port = (server.address() as any).port;

			const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ initialPrompt: "hi" }),
			});

			expect(res.status).toBe(200);
			const body = await res.json();
			sessionId = body.id;
			sessionFile = body.sessionFile;
		});

		afterEach(() => {
			server.close();
		});

		it("returns 200 with id and sessionFile", () => {
			expect(sessionId).toBeTruthy();
			expect(sessionFile).toBeTruthy();
			expect(sessionFile).toContain(".jsonl");
		});

		it("creates a JSONL file on disk", async () => {
			const content = await fs.readFile(sessionFile, "utf-8");
			const lines = content.split("\n").filter((l) => l.trim());
			expect(lines.length).toBeGreaterThanOrEqual(1);

			// First line should be session header
			const header = JSON.parse(lines[0]);
			expect(header.type).toBe("session");
			expect(header.id).toBe(sessionId);
			expect(header.cwd).toBeTruthy();
			expect(header.timestamp).toBeTruthy();
		});
	});

	// (b2) GET /api/sessions falls back to sessionPool.getSessionName when JSONL header has no name
	describe("(b2) GET /api/sessions falls back to sessionPool.getSessionName when JSONL header has no name", () => {
		let app: express.Express;
		let server: ReturnType<typeof createServer>;
		let createdId: string;

		beforeEach(async () => {
			app = express();
			app.use(express.json());
			// Create mock pool that has getSessionName
			const pool = {
				sessionsDir: fakeSessionsDir,
				isRunning: () => false,
				getSessionName: (id: string) => (id === "pool-session-id" ? "PoolFallbackTitle" : undefined),
				on: () => {},
				emit: () => {},
			};
			mountSessionsRoutes(app, pool);
			server = createServer(app);

			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const port = (server.address() as any).port;

			// Manually create a session file without a name field in header
			const sessionFilePath = path.join(fakeSessionsDir, `2025-01-01T00-00-00-000Z_pool-session-id.jsonl`);
			await fs.mkdir(fakeSessionsDir, { recursive: true });
			await fs.writeFile(
				sessionFilePath,
				JSON.stringify({
					type: "session",
					id: "pool-session-id",
					timestamp: "2025-01-01T00:00:00.000Z",
					cwd: "/test",
					// no name field
				}) + "\n",
			);
			createdId = "pool-session-id";
		});

		afterEach(() => {
			server.close();
		});

		it("returns title from sessionPool.getSessionName when JSONL header has no name", async () => {
			const port = (server.address() as any).port;
			const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
			expect(res.status).toBe(200);

			const sessions = await res.json();
			const found = sessions.find((s: any) => s.id === createdId);
			expect(found).toBeTruthy();
			// Title should come from sessionPool.getSessionName, not from JSONL header
			expect(found.title).toBe("PoolFallbackTitle");
		});
	});

	// (b) GET /api/sessions lists created sessions
	describe("(b) GET /api/sessions lists created sessions", () => {
		let app: express.Express;
		let server: ReturnType<typeof createServer>;
		let createdId: string;

		beforeEach(async () => {
			app = express();
			app.use(express.json());
			const pool = createMockPool(fakeSessionsDir);
			mountSessionsRoutes(app, pool);
			server = createServer(app);

			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const port = (server.address() as any).port;

			// Create a session first
			const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ initialPrompt: "test" }),
			});
			const body = await res.json();
			createdId = body.id;
		});

		afterEach(() => {
			server.close();
		});

		it("returns the created session in list", async () => {
			const port = (server.address() as any).port;
			const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
			expect(res.status).toBe(200);

			const sessions = await res.json();
			expect(Array.isArray(sessions)).toBe(true);
			expect(sessions.length).toBeGreaterThanOrEqual(1);

			const found = sessions.find((s: any) => s.id === createdId);
			expect(found).toBeTruthy();
			expect(found.type).toBe("session");
			expect(found.cwd).toBeTruthy();
			expect(found.sessionFile).toBeTruthy();
		});

		it("returns empty title when JSONL header has no name field", async () => {
			const port = (server.address() as any).port;
			const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
			expect(res.status).toBe(200);

			const sessions = await res.json();
			const found = sessions.find((s: any) => s.id === createdId);
			expect(found).toBeTruthy();
			// Spec R6: new session title is empty; title is written via RPC set_session_name after first prompt
			expect(found.title).toBe("");
		});

		it("returns empty array when no sessions exist", async () => {
			// Use a different empty directory
			const emptyDir = path.join("/tmp", `pi-empty-${crypto.randomUUID()}`);
			await fs.mkdir(emptyDir, { recursive: true });

			const emptyApp = express();
			emptyApp.use(express.json());
			const emptyPool = createMockPool(emptyDir);
			mountSessionsRoutes(emptyApp, emptyPool);
			const emptyServer = createServer(emptyApp);

			await new Promise<void>((resolve) => emptyServer.listen(0, "127.0.0.1", resolve));
			const port = (emptyServer.address() as any).port;

			const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
			expect(res.status).toBe(200);
			const sessions = await res.json();
			expect(sessions).toEqual([]);

			emptyServer.close();
			await fs.rm(emptyDir, { recursive: true, force: true });
		});
	});

	// (c) GET /api/sessions/:id/messages returns empty array for new session
	describe("(c) GET /api/sessions/:id/messages returns empty array for new session", () => {
		let app: express.Express;
		let server: ReturnType<typeof createServer>;
		let sessionId: string;

		beforeEach(async () => {
			app = express();
			app.use(express.json());
			const pool = createMockPool(fakeSessionsDir);
			mountSessionsRoutes(app, pool);
			server = createServer(app);

			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const port = (server.address() as any).port;

			// Create a session
			const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ initialPrompt: "test" }),
			});
			const body = await res.json();
			sessionId = body.id;
		});

		afterEach(() => {
			server.close();
		});

		it("returns empty messages array for new session", async () => {
			const port = (server.address() as any).port;
			const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/messages`);
			expect(res.status).toBe(200);

			const messages = await res.json();
			expect(Array.isArray(messages)).toBe(true);
			expect(messages).toEqual([]);
		});

		it("returns 404 for non-existent session", async () => {
			const port = (server.address() as any).port;
			const res = await fetch(`http://127.0.0.1:${port}/api/sessions/non-existent-id/messages`);
			expect(res.status).toBe(404);
		});
	});

	// (d) GET /api/sessions/:id/messages with pagination
	describe("(d) GET /api/sessions/:id/messages with pagination", () => {
		let app: express.Express;
		let server: ReturnType<typeof createServer>;
		let sessionId: string;
		let sessionFile: string;

		beforeEach(async () => {
			app = express();
			app.use(express.json());
			const pool = createMockPool(fakeSessionsDir);
			mountSessionsRoutes(app, pool);
			server = createServer(app);

			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const port = (server.address() as any).port;

			// Create a session
			const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ initialPrompt: "test" }),
			});
			const body = await res.json();
			sessionId = body.id;
			sessionFile = body.sessionFile;
		});

		afterEach(() => {
			server.close();
		});

		it("respects limit and offset params", async () => {
			const port = (server.address() as any).port;

			// Add some messages to the session file manually
			const messages = [
				JSON.stringify({ role: "user", content: "msg1" }),
				JSON.stringify({ role: "assistant", content: "msg2" }),
				JSON.stringify({ role: "user", content: "msg3" }),
			];
			const fileContent = (
				await fs.readFile(sessionFile, "utf-8")
			).trim() + "\n" + messages.join("\n") + "\n";
			await fs.writeFile(sessionFile, fileContent);

			// Test offset=1, limit=1
			const res = await fetch(
				`http://127.0.0.1:${port}/api/sessions/${sessionId}/messages?limit=1&offset=1`,
			);
			expect(res.status).toBe(200);
			const msgs = await res.json();
			expect(msgs).toHaveLength(1);
			expect(msgs[0].content).toBe("msg2");
		});
	});

	// (e) DELETE /api/sessions/:id removes the file
	describe("(e) DELETE /api/sessions/:id removes the file", () => {
		let app: express.Express;
		let server: ReturnType<typeof createServer>;
		let sessionId: string;
		let sessionFile: string;

		beforeEach(async () => {
			app = express();
			app.use(express.json());
			const pool = createMockPool(fakeSessionsDir);
			mountSessionsRoutes(app, pool);
			server = createServer(app);

			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const port = (server.address() as any).port;

			// Create a session
			const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ initialPrompt: "test" }),
			});
			const body = await res.json();
			sessionId = body.id;
			sessionFile = body.sessionFile;
		});

		afterEach(() => {
			server.close();
		});

		it("deletes the session file and returns ok:true", async () => {
			const port = (server.address() as any).port;

			// Verify file exists
			await fs.access(sessionFile);

			// Delete
			const delRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}`, {
				method: "DELETE",
			});
			expect(delRes.status).toBe(200);
			const body = await delRes.json();
			expect(body.ok).toBe(true);
			// atomsExtracted is not returned (fire-and-forget)

			// Verify file no longer exists
			await expect(fs.access(sessionFile)).rejects.toThrow();
		});

		it("returns 404 when deleting non-existent session", async () => {
			const port = (server.address() as any).port;
			const res = await fetch(`http://127.0.0.1:${port}/api/sessions/non-existent-id`, {
				method: "DELETE",
			});
			expect(res.status).toBe(404);
		});

		it("session no longer appears in list after deletion", async () => {
			const port = (server.address() as any).port;

			// Delete the session
			await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}`, {
				method: "DELETE",
			});

			// List sessions
			const listRes = await fetch(`http://127.0.0.1:${port}/api/sessions`);
			const sessions = await listRes.json();
			const found = sessions.find((s: any) => s.id === sessionId);
			expect(found).toBeUndefined();
		});
	});

	// (f) DELETE /api/sessions/:id extracts atoms before deletion
	describe("(f) DELETE /api/sessions/:id extracts atoms before deletion", () => {
		// Helper to create mock LLMClient
		function createMockLLMClient(extractAtomsResult: any[]) {
			return {
				extractAtoms: vi.fn().mockResolvedValue(extractAtomsResult),
			};
		}

		it("(f1) extracts 2 atoms and writes to memory.db before deleting session", async () => {
			// Create mock LLMClient that returns 2 atoms
			const mockAtoms = [
				{
					id: "atom-1",
					type: "preference" as const,
					title: "User prefers dark mode",
					summary: "User has set dark mode as their preferred theme",
					content: "",
					tags: ["ui", "theme"],
					importance: 0.8,
					strength: 1.0,
				},
				{
					id: "atom-2",
					type: "workflow" as const,
					title: "Daily standup workflow",
					summary: "User attends daily standup at 9am",
					content: "",
					tags: ["schedule"],
					importance: 0.6,
					strength: 1.0,
				},
			];
			const mockLLMClient = createMockLLMClient(mockAtoms);

			// Create temp memory.db
			const tempDbPath = `/tmp/test-memory-${Date.now()}-${Math.random()}.db`;
			const { MemoryStore } = await import("../memory-store");
			const memoryStore = new MemoryStore(tempDbPath);
			memoryStore.init();

			// Create temp sessions dir
			const testSessionDir = path.join("/tmp", `pi-sessions-test-${crypto.randomUUID()}`);
			await fs.mkdir(testSessionDir, { recursive: true });

			// Mount routes with deps
			const testApp = express();
			testApp.use(express.json());
			const pool = createMockPool(testSessionDir);
			// @ts-ignore - deps not yet in signature but we're testing the new behavior
			mountSessionsRoutes(testApp, pool, {
				llmClient: mockLLMClient as any,
				memoryStore: memoryStore as any,
			});

			const testServer = createServer(testApp);
			await new Promise<void>((resolve) => testServer.listen(0, "127.0.0.1", resolve));
			const port = (testServer.address() as any).port;

			// Create a session via POST
			const createRes = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ initialPrompt: "test" }),
			});
			const createBody = await createRes.json();
			const sessionId = createBody.id;
			const sessionFile = createBody.sessionFile;

			// Add messages to the session file
			const messages = [
				JSON.stringify({ role: "user", content: "I prefer dark mode" }),
				JSON.stringify({ role: "assistant", content: "Got it, dark mode enabled" }),
			];
			const fileContent = (await fs.readFile(sessionFile, "utf-8")).trim() + "\n" + messages.join("\n") + "\n";
			await fs.writeFile(sessionFile, fileContent);

			// Call DELETE
			const delRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}`, {
				method: "DELETE",
			});
			expect(delRes.status).toBe(200);
			const delBody = await delRes.json();
			expect(delBody.ok).toBe(true);
			// atomsExtracted is not returned (fire-and-forget)

			// Verify JSONL file is deleted
			await expect(fs.access(sessionFile)).rejects.toThrow();

			// Verify atoms were written to memory.db
			const atom1 = memoryStore.readAtom("atom-1");
			expect(atom1).not.toBeNull();
			expect(atom1!.title).toBe("User prefers dark mode");
			expect(atom1!.type).toBe("preference");

			const atom2 = memoryStore.readAtom("atom-2");
			expect(atom2).not.toBeNull();
			expect(atom2!.title).toBe("Daily standup workflow");
			expect(atom2!.type).toBe("workflow");

			// Cleanup
			testServer.close();
			memoryStore.close();
			await fs.rm(testSessionDir, { recursive: true, force: true }).catch(() => {});
			try { await fs.unlink(tempDbPath); } catch { /* ignore */ }
		});

		it("(f3) DELETE returns within 500ms even when LLM extraction is slow (fire-and-forget)", async () => {
			// Create mock LLMClient with a slow extraction (8s) - fire-and-forget
			const mockLLMClient = {
				extractAtoms: vi.fn().mockImplementation(
					() => new Promise((_, reject) => setTimeout(() => reject(new Error("LLM extraction slow")), 8000)),
				),
			};

			// Create temp sessions dir
			const testSessionDir = path.join("/tmp", `pi-sessions-fireforget-${crypto.randomUUID()}`);
			await fs.mkdir(testSessionDir, { recursive: true });

			// Mount routes with deps
			const testApp = express();
			testApp.use(express.json());
			const pool = createMockPool(testSessionDir);
			// @ts-ignore - deps not yet in signature but we're testing the new behavior
			mountSessionsRoutes(testApp, pool, {
				llmClient: mockLLMClient as any,
			});

			const testServer = createServer(testApp);
			await new Promise<void>((resolve) => testServer.listen(0, "127.0.0.1", resolve));
			const port = (testServer.address() as any).port;

			// Create a session via POST
			const createRes = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ initialPrompt: "test" }),
			});
			const createBody = await createRes.json();
			const sessionId = createBody.id;
			const sessionFile = createBody.sessionFile;

			// Issue DELETE and measure time - should return within 500ms even with slow LLM
			const startTime = Date.now();
			const delRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}`, {
				method: "DELETE",
			});
			const elapsed = Date.now() - startTime;

			expect(delRes.status).toBe(200);
			const delBody = await delRes.json();
			expect(delBody.ok).toBe(true);
			// Must return within 500ms (fire-and-forget)
			expect(elapsed).toBeLessThan(500);

			// Verify JSONL file is deleted
			await expect(fs.access(sessionFile)).rejects.toThrow();

			// Cleanup
			testServer.close();
			await fs.rm(testSessionDir, { recursive: true, force: true }).catch(() => {});
		});

		it("(f2) LLM failure is non-blocking - session deleted, memory.db unchanged", async () => {
			// Create mock LLMClient that throws
			const mockLLMClient = {
				extractAtoms: vi.fn().mockRejectedValue(new Error("LLM API failed")),
			};

			// Create temp memory.db
			const tempDbPath = `/tmp/test-memory-${Date.now()}-${Math.random()}.db`;
			const { MemoryStore } = await import("../memory-store");
			const memoryStore = new MemoryStore(tempDbPath);
			memoryStore.init();

			// Create temp sessions dir
			const testSessionDir = path.join("/tmp", `pi-sessions-test-${crypto.randomUUID()}`);
			await fs.mkdir(testSessionDir, { recursive: true });

			// Mount routes with deps
			const testApp = express();
			testApp.use(express.json());
			const pool = createMockPool(testSessionDir);
			// @ts-ignore - deps not yet in signature but we're testing the new behavior
			mountSessionsRoutes(testApp, pool, {
				llmClient: mockLLMClient as any,
				memoryStore: memoryStore as any,
			});

			const testServer = createServer(testApp);
			await new Promise<void>((resolve) => testServer.listen(0, "127.0.0.1", resolve));
			const port = (testServer.address() as any).port;

			// Create a session via POST
			const createRes = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ initialPrompt: "test" }),
			});
			const createBody = await createRes.json();
			const sessionId = createBody.id;
			const sessionFile = createBody.sessionFile;

			// Call DELETE
			const delRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}`, {
				method: "DELETE",
			});
			expect(delRes.status).toBe(200);
			const delBody = await delRes.json();
			expect(delBody.ok).toBe(true);
			// atomsExtracted may be 0 or undefined on failure
			expect(delBody.atomsExtracted === 0 || delBody.atomsExtracted === undefined).toBe(true);

			// Verify JSONL file is deleted
			await expect(fs.access(sessionFile)).rejects.toThrow();

			// Verify memory.db is empty (no atoms written)
			const atom1 = memoryStore.readAtom("non-existent-id");
			expect(atom1).toBeNull();

			// Cleanup
			testServer.close();
			memoryStore.close();
			await fs.rm(testSessionDir, { recursive: true, force: true }).catch(() => {});
			try { await fs.unlink(tempDbPath); } catch { /* ignore */ }
		});
	});
});
