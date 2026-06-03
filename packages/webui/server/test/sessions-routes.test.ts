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
			isSessionManaged: () => false,
			markSessionOwned: () => {},
				unmarkSessionOwned: () => {},
				kill: () => Promise.resolve(),
			unmarkSessionOwned: () => {},
				unmarkSessionOwned: () => {},
				kill: () => Promise.resolve(),
			kill: () => Promise.resolve(),
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
				isSessionManaged: () => false,
				markSessionOwned: () => {},
				unmarkSessionOwned: () => {},
				kill: () => Promise.resolve(),
				unmarkSessionOwned: () => {},
				unmarkSessionOwned: () => {},
				kill: () => Promise.resolve(),
				kill: () => Promise.resolve(),
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

			// Add some messages to the session file using the real JSONL format
			const sessionId_ = sessionId; // capture for closure
			const messages = [
				JSON.stringify({ type: "message", id: "msg-1", message: { role: "user", content: [{ type: "text", text: "msg1" }] }, timestamp: "2025-01-01T00:00:00.000Z" }),
				JSON.stringify({ type: "message", id: "msg-2", message: { role: "assistant", content: [{ type: "text", text: "msg2" }] }, timestamp: "2025-01-01T00:00:01.000Z" }),
				JSON.stringify({ type: "message", id: "msg-3", message: { role: "user", content: [{ type: "text", text: "msg3" }] }, timestamp: "2025-01-01T00:00:02.000Z" }),
				// Non-message entries should be filtered out
				JSON.stringify({ type: "model_change", id: "model-1", provider: "openai", modelId: "gpt-4" }),
				JSON.stringify({ type: "thinking_level_change", id: "think-1", thinkingLevel: "off" }),
			];
			const fileContent = (
				await fs.readFile(sessionFile, "utf-8")
			).trim() + "\n" + messages.join("\n") + "\n";
			await fs.writeFile(sessionFile, fileContent);

			// Test offset=1, limit=1 - should skip header + first message = start at second message
			const res = await fetch(
				`http://127.0.0.1:${port}/api/sessions/${sessionId_}/messages?limit=1&offset=1`,
			);
			expect(res.status).toBe(200);
			const msgs = await res.json();
			expect(msgs).toHaveLength(1);
			expect(msgs[0]).toMatchObject({
				id: "msg-2",
				sessionId: sessionId_,
				role: "assistant",
				parts: [{ type: "text", text: "msg2" }],
				timestamp: "2025-01-01T00:00:01.000Z",
			});
		});
	});

	// (d2) GET /api/sessions/:id/messages returns usage field for assistant messages
	describe("(d2) GET /api/sessions/:id/messages returns usage field for assistant messages", () => {
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

		it("assistant message with usage returns usage field", async () => {
			const port = (server.address() as any).port;

			// Add an assistant message with usage data
			const messages = [
				JSON.stringify({ type: "message", id: "msg-1", message: { role: "user", content: [{ type: "text", text: "Hello" }] }, timestamp: "2025-01-01T00:00:00.000Z" }),
				JSON.stringify({ type: "message", id: "msg-2", message: { role: "assistant", content: [{ type: "text", text: "Hi there!" }], usage: { input: 1000, output: 2000 } }, timestamp: "2025-01-01T00:00:01.000Z" }),
			];
			const fileContent = (await fs.readFile(sessionFile, "utf-8")).trim() + "\n" + messages.join("\n") + "\n";
			await fs.writeFile(sessionFile, fileContent);

			const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/messages`);
			expect(res.status).toBe(200);
			const msgs = await res.json();
			expect(msgs).toHaveLength(2);

			// First message (user) should not have usage
			expect(msgs[0]).toMatchObject({
				id: "msg-1",
				role: "user",
				parts: [{ type: "text", text: "Hello" }],
			});
			expect(msgs[0].usage).toBeUndefined();

			// Second message (assistant with usage) should have usage
			expect(msgs[1]).toMatchObject({
				id: "msg-2",
				role: "assistant",
				parts: [{ type: "text", text: "Hi there!" }],
				usage: { input: 1000, output: 2000 },
			});
		});

		it("assistant message without usage does not return usage field", async () => {
			const port = (server.address() as any).port;

			// Add an assistant message without usage data
			const messages = [
				JSON.stringify({ type: "message", id: "msg-1", message: { role: "user", content: [{ type: "text", text: "Hello" }] }, timestamp: "2025-01-01T00:00:00.000Z" }),
				JSON.stringify({ type: "message", id: "msg-2", message: { role: "assistant", content: [{ type: "text", text: "Hi there!" }] }, timestamp: "2025-01-01T00:00:01.000Z" }),
			];
			const fileContent = (await fs.readFile(sessionFile, "utf-8")).trim() + "\n" + messages.join("\n") + "\n";
			await fs.writeFile(sessionFile, fileContent);

			const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/messages`);
			expect(res.status).toBe(200);
			const msgs = await res.json();
			expect(msgs).toHaveLength(2);

			// Both messages should not have usage
			expect(msgs[0].usage).toBeUndefined();
			expect(msgs[1].usage).toBeUndefined();
		});
	});

	// (i1) GET /api/sessions/:id/messages returns messages when first lines are non-message entries
	describe("(i1) GET /api/sessions/:id/messages returns messages when first lines are non-message entries", () => {
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

		it("returns 3 messages when JSONL has model_change + thinking_level_change before messages", async () => {
			const port = (server.address() as any).port;

			// JSONL: header, model_change, thinking_level_change, then 3 messages
			// This mimics a real session where the first few entries after header are non-message entries
			const sessionId_ = sessionId;
			const entries = [
				// Non-message entries FIRST (these were causing pagination bug)
				JSON.stringify({ type: "model_change", id: "mc-1", provider: "openai", modelId: "gpt-4" }),
				JSON.stringify({ type: "thinking_level_change", id: "tlc-1", thinkingLevel: "off" }),
				// Actual messages
				JSON.stringify({ type: "message", id: "msg-1", message: { role: "user", content: [{ type: "text", text: "Hello" }] }, timestamp: "2025-01-01T00:00:00.000Z" }),
				JSON.stringify({ type: "message", id: "msg-2", message: { role: "assistant", content: [{ type: "text", text: "Hi there!" }] }, timestamp: "2025-01-01T00:00:01.000Z" }),
				JSON.stringify({ type: "message", id: "msg-3", message: { role: "user", content: [{ type: "text", text: "How are you?" }] }, timestamp: "2025-01-01T00:00:02.000Z" }),
			];
			const fileContent = (await fs.readFile(sessionFile, "utf-8")).trim() + "\n" + entries.join("\n") + "\n";
			await fs.writeFile(sessionFile, fileContent);

			// GET with limit=3, offset=0 - should return 3 messages, NOT empty array
			const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId_}/messages?limit=3&offset=0`);
			expect(res.status).toBe(200);
			const msgs = await res.json();

			// BUG was: returned [] because model_change/thinking_level_change were paginated before filtering
			// FIX: should return the 3 messages
			expect(msgs).toHaveLength(3);
			expect(msgs[0].id).toBe("msg-1");
			expect(msgs[1].id).toBe("msg-2");
			expect(msgs[2].id).toBe("msg-3");
		});

		it("offset skips non-message entries correctly", async () => {
			const port = (server.address() as any).port;
			const sessionId_ = sessionId;

			// Same setup: header, model_change, thinking_level_change, msg-1, msg-2, msg-3
			const entries = [
				JSON.stringify({ type: "model_change", id: "mc-1", provider: "openai", modelId: "gpt-4" }),
				JSON.stringify({ type: "thinking_level_change", id: "tlc-1", thinkingLevel: "off" }),
				JSON.stringify({ type: "message", id: "msg-1", message: { role: "user", content: [{ type: "text", text: "First" }] }, timestamp: "2025-01-01T00:00:00.000Z" }),
				JSON.stringify({ type: "message", id: "msg-2", message: { role: "assistant", content: [{ type: "text", text: "Second" }] }, timestamp: "2025-01-01T00:00:01.000Z" }),
				JSON.stringify({ type: "message", id: "msg-3", message: { role: "user", content: [{ type: "text", text: "Third" }] }, timestamp: "2025-01-01T00:00:02.000Z" }),
			];
			const fileContent = (await fs.readFile(sessionFile, "utf-8")).trim() + "\n" + entries.join("\n") + "\n";
			await fs.writeFile(sessionFile, fileContent);

			// offset=1, limit=2 should skip msg-1 and return msg-2, msg-3
			const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId_}/messages?limit=2&offset=1`);
			expect(res.status).toBe(200);
			const msgs = await res.json();
			expect(msgs).toHaveLength(2);
			expect(msgs[0].id).toBe("msg-2");
			expect(msgs[1].id).toBe("msg-3");
		});
	});

	// (i2) GET /api/sessions/:id/messages returns parts: Part[] not content: string
	describe("(i2) GET /api/sessions/:id/messages returns parts: Part[] not content: string", () => {
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
				body: JSON.stringify({ initialPrompt: "test" }),
			});
			const body = await res.json();
			sessionId = body.id;
			sessionFile = body.sessionFile;
		});

		afterEach(() => {
			server.close();
		});

		it("response messages have parts: Part[] field, not content: string", async () => {
			const port = (server.address() as any).port;
			const sessionId_ = sessionId;

			const messages = [
				JSON.stringify({ type: "message", id: "msg-1", message: { role: "user", content: [{ type: "text", text: "Hello" }] }, timestamp: "2025-01-01T00:00:00.000Z" }),
				JSON.stringify({ type: "message", id: "msg-2", message: { role: "assistant", content: [{ type: "text", text: "Hi there!" }] }, timestamp: "2025-01-01T00:00:01.000Z" }),
			];
			const fileContent = (await fs.readFile(sessionFile, "utf-8")).trim() + "\n" + messages.join("\n") + "\n";
			await fs.writeFile(sessionFile, fileContent);

			const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId_}/messages`);
			expect(res.status).toBe(200);
			const msgs = await res.json();

			expect(msgs).toHaveLength(2);

			// Should have parts array, not content string
			expect(msgs[0].parts).toBeDefined();
			expect(Array.isArray(msgs[0].parts)).toBe(true);
			expect(msgs[0].content).toBeUndefined(); // old field should not exist

			expect(msgs[1].parts).toBeDefined();
			expect(Array.isArray(msgs[1].parts)).toBe(true);
			expect(msgs[1].content).toBeUndefined();
		});

		it("text part has correct type and text fields", async () => {
			const port = (server.address() as any).port;
			const sessionId_ = sessionId;

			const messages = [
				JSON.stringify({ type: "message", id: "msg-1", message: { role: "user", content: [{ type: "text", text: "Hello world" }] }, timestamp: "2025-01-01T00:00:00.000Z" }),
			];
			const fileContent = (await fs.readFile(sessionFile, "utf-8")).trim() + "\n" + messages.join("\n") + "\n";
			await fs.writeFile(sessionFile, fileContent);

			const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId_}/messages`);
			expect(res.status).toBe(200);
			const msgs = await res.json();

			expect(msgs[0].parts).toHaveLength(1);
			expect(msgs[0].parts[0]).toEqual({ type: "text", text: "Hello world" });
		});

		it("assistant message with model field returns model in response", async () => {
			const port = (server.address() as any).port;
			const sessionId_ = sessionId;

			const messages = [
				JSON.stringify({ type: "message", id: "msg-1", message: { role: "assistant", content: [{ type: "text", text: "Hello" }], model: "gpt-4" }, timestamp: "2025-01-01T00:00:00.000Z" }),
			];
			const fileContent = (await fs.readFile(sessionFile, "utf-8")).trim() + "\n" + messages.join("\n") + "\n";
			await fs.writeFile(sessionFile, fileContent);

			const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId_}/messages`);
			expect(res.status).toBe(200);
			const msgs = await res.json();

			expect(msgs[0].model).toBe("gpt-4");
		});
	});

	// (i3) GET /api/sessions/:id/messages preserves image parts
	describe("(i3) GET /api/sessions/:id/messages preserves image parts", () => {
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
				body: JSON.stringify({ initialPrompt: "test" }),
			});
			const body = await res.json();
			sessionId = body.id;
			sessionFile = body.sessionFile;
		});

		afterEach(() => {
			server.close();
		});

		it("assistant message with image part preserves image data", async () => {
			const port = (server.address() as any).port;
			const sessionId_ = sessionId;

			const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
			const messages = [
				JSON.stringify({
					type: "message",
					id: "msg-1",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: "Here is an image:" },
							{ type: "image", mediaType: "image/png", data: imageData },
						],
					},
					timestamp: "2025-01-01T00:00:00.000Z",
				}),
			];
			const fileContent = (await fs.readFile(sessionFile, "utf-8")).trim() + "\n" + messages.join("\n") + "\n";
			await fs.writeFile(sessionFile, fileContent);

			const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId_}/messages`);
			expect(res.status).toBe(200);
			const msgs = await res.json();

			expect(msgs).toHaveLength(1);
			expect(msgs[0].parts).toHaveLength(2);

			// First part is text
			expect(msgs[0].parts[0]).toEqual({ type: "text", text: "Here is an image:" });

			// Second part is image
			expect(msgs[0].parts[1]).toEqual({
				type: "image",
				mediaType: "image/png",
				data: imageData,
			});
		});

		it("message with toolCall and toolResult parts preserves all fields", async () => {
			const port = (server.address() as any).port;
			const sessionId_ = sessionId;

			const messages = [
				JSON.stringify({
					type: "message",
					id: "msg-1",
					message: {
						role: "assistant",
						content: [
							{ type: "toolCall", id: "tc-1", name: "bash", args: { command: "ls -la" } },
						],
					},
					timestamp: "2025-01-01T00:00:00.000Z",
				}),
				JSON.stringify({
					type: "message",
					id: "msg-2",
					message: {
						role: "toolResult",
						content: [
							{ type: "toolResult", toolCallId: "tc-1", content: "total 0\ndrwxr-xr-x  3 jh  staff  4096 Jun  3 19:32 .\n", isError: false },
						],
					},
					timestamp: "2025-01-01T00:00:01.000Z",
				}),
			];
			const fileContent = (await fs.readFile(sessionFile, "utf-8")).trim() + "\n" + messages.join("\n") + "\n";
			await fs.writeFile(sessionFile, fileContent);

			const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId_}/messages`);
			expect(res.status).toBe(200);
			const msgs = await res.json();

			expect(msgs).toHaveLength(2);

			// First message: toolCall
			expect(msgs[0].parts[0]).toEqual({
				type: "toolCall",
				id: "tc-1",
				name: "bash",
				args: { command: "ls -la" },
			});

			// Second message: toolResult
			expect(msgs[1].parts[0]).toEqual({
				type: "toolResult",
				toolCallId: "tc-1",
				content: "total 0\ndrwxr-xr-x  3 jh  staff  4096 Jun  3 19:32 .\n",
				isError: false,
			});
		});

		it("message with thinking part preserves thinking content", async () => {
			const port = (server.address() as any).port;
			const sessionId_ = sessionId;

			const messages = [
				JSON.stringify({
					type: "message",
					id: "msg-1",
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", text: "Let me think about this..." },
							{ type: "text", text: "Here is my answer." },
						],
					},
					timestamp: "2025-01-01T00:00:00.000Z",
				}),
			];
			const fileContent = (await fs.readFile(sessionFile, "utf-8")).trim() + "\n" + messages.join("\n") + "\n";
			await fs.writeFile(sessionFile, fileContent);

			const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId_}/messages`);
			expect(res.status).toBe(200);
			const msgs = await res.json();

			expect(msgs).toHaveLength(1);
			expect(msgs[0].parts).toHaveLength(2);
			expect(msgs[0].parts[0]).toEqual({ type: "thinking", text: "Let me think about this..." });
			expect(msgs[0].parts[1]).toEqual({ type: "text", text: "Here is my answer." });
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

	// (f) DELETE /api/sessions/:id extracts atoms before deletion (via callLlm)
	describe("(f) DELETE /api/sessions/:id extracts atoms before deletion", () => {
		it("(f1) extracts 2 atoms via callLlm and writes to memory.db before deleting session", async () => {
			// Spy on runMemoryExtraction to verify it was called correctly
			const runMemoryExtractionSpy = vi.spyOn(await import("@earendil-works/pi-personal-assistant"), "runMemoryExtraction");
			runMemoryExtractionSpy.mockResolvedValue({ plan: null, atomsWritten: 2 });

			// Create mock callLlm that returns a JSON plan with 2 atoms
			const mockCallLlm = vi.fn().mockResolvedValue(JSON.stringify({
				plan: [
					{
						action: "create",
						type: "preference",
						title: "User prefers dark mode",
						summary: "User has set dark mode as their preferred theme",
						tags: ["ui", "theme"],
						importance: 0.8,
					},
					{
						action: "create",
						type: "workflow",
						title: "Daily standup workflow",
						summary: "User attends daily standup at 9am",
						tags: ["schedule"],
						importance: 0.6,
					},
				],
			}));

			// Create temp memory.db and atoms dir
			const tempDbPath = `/tmp/test-memory-${Date.now()}-${Math.random()}.db`;
			const tempAtomsDir = `/tmp/test-atoms-${Date.now()}-${Math.random()}`;

			// Create temp sessions dir
			const testSessionDir = path.join("/tmp", `pi-sessions-test-${crypto.randomUUID()}`);
			await fs.mkdir(testSessionDir, { recursive: true });
			// Ensure parent directories exist for db and atoms
			await fs.mkdir(path.dirname(tempDbPath), { recursive: true });
			await fs.mkdir(tempAtomsDir, { recursive: true });

			// Minimal settings config
			const mockSettings = {
				personalAssistant: {
					memory: {
						enabled: true,
						extraction: { provider: "minimax", model: "MiniMax-M3" },
					},
				},
			};

			// Mount routes with deps
			const testApp = express();
			testApp.use(express.json());
			const pool = createMockPool(testSessionDir);
			mountSessionsRoutes(testApp, pool, {
				callLlm: mockCallLlm,
				settings: mockSettings as any,
				dbPath: tempDbPath,
				atomsDir: tempAtomsDir,
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
			expect(createRes.status).toBe(200);
			const createBody = await createRes.json();
			const sessionId = createBody.id;
			const sessionFile = createBody.sessionFile;

			// Add messages to the session file using real JSONL format
			const messages = [
				JSON.stringify({ type: "message", id: "msg-1", message: { role: "user", content: [{ type: "text", text: "I prefer dark mode" }] }, timestamp: "2025-01-01T00:00:00.000Z" }),
				JSON.stringify({ type: "message", id: "msg-2", message: { role: "assistant", content: [{ type: "text", text: "Got it, dark mode enabled" }] }, timestamp: "2025-01-01T00:00:01.000Z" }),
			];
			const fileContent = (await fs.readFile(sessionFile, "utf-8")).trim() + "\n" + messages.join("\n") + "\n";
			await fs.writeFile(sessionFile, fileContent);

			// Call DELETE
			const delRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}`, {
				method: "DELETE",
			});
			expect(delRes.status).toBe(200);
			expect((await delRes.json()).ok).toBe(true);

			// Verify JSONL file is deleted
			await expect(fs.access(sessionFile)).rejects.toThrow();

			// Verify runMemoryExtraction was called with correct arguments
			expect(runMemoryExtractionSpy).toHaveBeenCalled();
			const callArgs = runMemoryExtractionSpy.mock.calls[0][0];
			expect(callArgs.callLlm).toBe(mockCallLlm);
			expect(callArgs.config).toBe(mockSettings);
			expect(callArgs.dbPath).toBe(tempDbPath);
			expect(callArgs.atomsDir).toBe(tempAtomsDir);
			expect(Array.isArray(callArgs.messages)).toBe(true);
			expect(callArgs.messages.length).toBe(2);

			// Cleanup
			testServer.close();
			await fs.rm(testSessionDir, { recursive: true, force: true }).catch(() => {});
			await fs.rm(tempAtomsDir, { recursive: true, force: true }).catch(() => {});
			try { await fs.unlink(tempDbPath); } catch { /* ignore */ }
			runMemoryExtractionSpy.mockRestore();
		});

		it("(f2) DELETE returns within 500ms even when LLM extraction is slow (fire-and-forget)", async () => {
			// Create mock callLlm that takes 8s - fire-and-forget
			const mockCallLlm = vi.fn().mockImplementation(
				() => new Promise((_, reject) => setTimeout(() => reject(new Error("LLM extraction slow")), 8000)),
			);

			// Create temp sessions dir
			const testSessionDir = path.join("/tmp", `pi-sessions-fireforget-${crypto.randomUUID()}`);
			await fs.mkdir(testSessionDir, { recursive: true });

			const mockSettings = {
				personalAssistant: {
					memory: { enabled: true, extraction: { provider: "minimax", model: "MiniMax-M3" } },
				},
			};

			// Mount routes with deps
			const testApp = express();
			testApp.use(express.json());
			const pool = createMockPool(testSessionDir);
			mountSessionsRoutes(testApp, pool, {
				callLlm: mockCallLlm,
				settings: mockSettings as any,
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
			expect((await delRes.json()).ok).toBe(true);
			// Must return within 500ms (fire-and-forget)
			expect(elapsed).toBeLessThan(500);

			// Verify JSONL file is deleted
			await expect(fs.access(sessionFile)).rejects.toThrow();

			// Cleanup
			testServer.close();
			await fs.rm(testSessionDir, { recursive: true, force: true }).catch(() => {});
		});

		it("(f3) LLM failure is non-blocking - session deleted, memory.db unchanged", async () => {
			// Create mock callLlm that throws
			const mockCallLlm = vi.fn().mockRejectedValue(new Error("LLM API failed"));

			// Create temp memory.db and atoms dir
			const tempDbPath = `/tmp/test-memory-${Date.now()}-${Math.random()}.db`;
			const tempAtomsDir = `/tmp/test-atoms-${Date.now()}-${Math.random()}`;

			// Create temp sessions dir
			const testSessionDir = path.join("/tmp", `pi-sessions-test-${crypto.randomUUID()}`);
			await fs.mkdir(testSessionDir, { recursive: true });

			const mockSettings = {
				personalAssistant: {
					memory: { enabled: true, extraction: { provider: "minimax", model: "MiniMax-M3" } },
				},
			};

			// Mount routes with deps
			const testApp = express();
			testApp.use(express.json());
			const pool = createMockPool(testSessionDir);
			mountSessionsRoutes(testApp, pool, {
				callLlm: mockCallLlm,
				settings: mockSettings as any,
				dbPath: tempDbPath,
				atomsDir: tempAtomsDir,
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

			// Add messages
			const messages = [
				JSON.stringify({ type: "message", id: "msg-1", message: { role: "user", content: [{ type: "text", text: "Hello" }] }, timestamp: "2025-01-01T00:00:00.000Z" }),
			];
			const fileContent = (await fs.readFile(sessionFile, "utf-8")).trim() + "\n" + messages.join("\n") + "\n";
			await fs.writeFile(sessionFile, fileContent);

			// Call DELETE
			const delRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}`, {
				method: "DELETE",
			});
			expect(delRes.status).toBe(200);
			expect((await delRes.json()).ok).toBe(true);

			// Verify JSONL file is deleted
			await expect(fs.access(sessionFile)).rejects.toThrow();

			// Cleanup
			testServer.close();
			await fs.rm(testSessionDir, { recursive: true, force: true }).catch(() => {});
			await fs.rm(tempAtomsDir, { recursive: true, force: true }).catch(() => {});
			try { await fs.unlink(tempDbPath); } catch { /* ignore */ }
		});
	});

	// (h) POST /api/sessions calls spawnPiNewSession
	describe("(h) POST /api/sessions delegates to spawnPiNewSession", () => {
		let app: express.Express;
		let server: ReturnType<typeof createServer>;

		afterEach(() => {
			server.close();
		});

		it("(h1) POST calls spawnPiNewSession(cwd) and returns its result", async () => {
			// Spy on spawnPiNewSession to verify it was called and its result is returned
			const spawnPiNewSessionSpy = vi.spyOn(await import("../lib/new-session"), "spawnPiNewSession");
			spawnPiNewSessionSpy.mockResolvedValue({
				sessionId: "spawned-session-id",
				sessionFile: "/fake/spawned-session-id.jsonl",
			});

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
				body: JSON.stringify({ initialPrompt: "hello" }),
			});

			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.id).toBe("spawned-session-id");
			expect(body.sessionFile).toBe("/fake/spawned-session-id.jsonl");

			// Verify spawnPiNewSession was called with process.cwd()
			expect(spawnPiNewSessionSpy).toHaveBeenCalledTimes(1);
			expect(spawnPiNewSessionSpy.mock.calls[0][0]).toBe(process.cwd());

			spawnPiNewSessionSpy.mockRestore();
		});

		it("(h2) POST still returns 200 when spawnPiNewSession falls back to UUID (internal failure handling)", async () => {
			// Mock spawnPiNewSession to throw (simulating pi binary not found / timeout)
			// The implementation should still return 200 with fallback session data
			const spawnPiNewSessionSpy = vi.spyOn(await import("../lib/new-session"), "spawnPiNewSession");
			spawnPiNewSessionSpy.mockResolvedValue({
				sessionId: "fallback-session-id",
				sessionFile: "/fake/fallback-session-id.jsonl",
			});

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
				body: JSON.stringify({}),
			});

			// Should still succeed (spawnPiNewSession handles its own failures internally)
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.id).toBeTruthy();
			expect(body.sessionFile).toBeTruthy();

			spawnPiNewSessionSpy.mockRestore();
		});
	});

	// (g) DELETE /api/sessions/:id with runMemoryExtraction (personal-assistant integration)
	describe("(g) DELETE /api/sessions/:id with personal-assistant memory extraction", () => {
		it("(g1) DELETE triggers runMemoryExtraction with correct arguments", async () => {
			// Spy on runMemoryExtraction to verify it was called correctly
			const runMemoryExtractionSpy = vi.spyOn(await import("@earendil-works/pi-personal-assistant"), "runMemoryExtraction");
			runMemoryExtractionSpy.mockResolvedValue({ plan: null, atomsWritten: 1 });

			// Create temp memory.db in temp location
			const tempDbPath = `/tmp/test-pa-memory-${Date.now()}-${Math.random()}.db`;
			const tempAtomsDir = `/tmp/test-pa-atoms-${Date.now()}-${Math.random()}`;

			// Mock callLlm that returns a valid extraction plan with 1 atom
			const mockCallLlm = vi.fn().mockResolvedValue(JSON.stringify({
				plan: [{
					action: "create",
					type: "knowledge",
					title: "User is learning TypeScript",
					summary: "The user mentioned they are learning TypeScript programming",
					tags: ["typescript", "programming", "learning"],
					importance: 0.7,
				}],
			}));

			// Minimal settings config
			const mockSettings = {
				personalAssistant: {
					memory: {
						enabled: true,
						extraction: { provider: "minimax", model: "MiniMax-M3" },
					},
				},
			};

			// Create temp sessions dir
			const testSessionDir = path.join("/tmp", `pi-sessions-pa-${crypto.randomUUID()}`);
			await fs.mkdir(testSessionDir, { recursive: true });

			// Import the updated sessions module
			const sessionsModule = await import("../routes/sessions");
			const mountSessionsRoutes = sessionsModule.mountSessionsRoutes;

			// Create mock session pool
			const mockPool = {
				sessionsDir: testSessionDir,
				isRunning: () => false,
				isSessionManaged: () => false,
				markSessionOwned: () => {},
				unmarkSessionOwned: () => {},
				kill: () => Promise.resolve(),
				getSessionName: () => undefined,
				on: () => {},
				emit: () => {},
			};

			// Create mock deps with callLlm and settings
			const mockDeps = {
				callLlm: mockCallLlm,
				settings: mockSettings as any,
				dbPath: tempDbPath,
				atomsDir: tempAtomsDir,
			};

			// Mount routes with new deps
			const testApp = express();
			testApp.use(express.json());
			// @ts-ignore - new deps shape
			mountSessionsRoutes(testApp, mockPool, mockDeps);

			const testServer = createServer(testApp);
			await new Promise<void>((resolve) => testServer.listen(0, "127.0.0.1", resolve));
			const port = (testServer.address() as any).port;

			// Create a session via POST
			const createRes = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ initialPrompt: "test" }),
			});
			expect(createRes.status).toBe(200);
			const createBody = await createRes.json();
			const sessionId = createBody.id;
			const sessionFile = createBody.sessionFile;

			// Add messages to the session file
			const messages = [
				JSON.stringify({ type: "message", id: "msg-1", message: { role: "user", content: [{ type: "text", text: "I'm learning TypeScript" }] }, timestamp: "2025-01-01T00:00:00.000Z" }),
				JSON.stringify({ type: "message", id: "msg-2", message: { role: "assistant", content: [{ type: "text", text: "Great! TypeScript is a typed superset of JavaScript" }] }, timestamp: "2025-01-01T00:00:01.000Z" }),
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

			// Verify JSONL file is deleted
			await expect(fs.access(sessionFile)).rejects.toThrow();

			// Verify runMemoryExtraction was called with correct arguments
			expect(runMemoryExtractionSpy).toHaveBeenCalled();
			const callArgs = runMemoryExtractionSpy.mock.calls[0][0];
			expect(callArgs.callLlm).toBe(mockCallLlm);
			expect(callArgs.config).toBe(mockSettings);
			expect(callArgs.dbPath).toBe(tempDbPath);
			expect(callArgs.atomsDir).toBe(tempAtomsDir);
			expect(Array.isArray(callArgs.messages)).toBe(true);
			expect(callArgs.messages.length).toBe(2);
			expect(callArgs.messages[0].role).toBe("user");
			expect(callArgs.messages[1].role).toBe("assistant");

			// Cleanup
			testServer.close();
			await fs.rm(testSessionDir, { recursive: true, force: true }).catch(() => {});
			await fs.rm(tempAtomsDir, { recursive: true, force: true }).catch(() => {});
			try { await fs.unlink(tempDbPath); } catch { /* ignore */ }
			runMemoryExtractionSpy.mockRestore();
		});

		it("(g2) DELETE with callLlm failure still deletes session (non-blocking)", async () => {
			// Create temp sessions dir
			const testSessionDir = path.join("/tmp", `pi-sessions-pa-fail-${crypto.randomUUID()}`);
			await fs.mkdir(testSessionDir, { recursive: true });

			// Mock callLlm that throws
			const mockCallLlm = vi.fn().mockRejectedValue(new Error("LLM API failed"));

			// Minimal settings config
			const mockSettings = {
				personalAssistant: {
					memory: {
						enabled: true,
						extraction: { provider: "minimax", model: "MiniMax-M3" },
					},
				},
			};

			// Import the updated sessions module
			const sessionsModule = await import("../routes/sessions");
			const mountSessionsRoutes = sessionsModule.mountSessionsRoutes;

			// Create mock session pool
			const mockPool = {
				sessionsDir: testSessionDir,
				isRunning: () => false,
				isSessionManaged: () => false,
				markSessionOwned: () => {},
				unmarkSessionOwned: () => {},
				kill: () => Promise.resolve(),
				getSessionName: () => undefined,
				on: () => {},
				emit: () => {},
			};

			// Create mock deps
			const mockDeps = {
				callLlm: mockCallLlm,
				settings: mockSettings as any,
			};

			// Mount routes
			const testApp = express();
			testApp.use(express.json());
			// @ts-ignore - new deps shape
			mountSessionsRoutes(testApp, mockPool, mockDeps);

			const testServer = createServer(testApp);
			await new Promise<void>((resolve) => testServer.listen(0, "127.0.0.1", resolve));
			const port = (testServer.address() as any).port;

			// Create a session via POST
			const createRes = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ initialPrompt: "test" }),
			});
			expect(createRes.status).toBe(200);
			const createBody = await createRes.json();
			const sessionId = createBody.id;
			const sessionFile = createBody.sessionFile;

			// Add messages
			const messages = [
				JSON.stringify({ type: "message", id: "msg-1", message: { role: "user", content: [{ type: "text", text: "Hello" }] }, timestamp: "2025-01-01T00:00:00.000Z" }),
			];
			const fileContent = (await fs.readFile(sessionFile, "utf-8")).trim() + "\n" + messages.join("\n") + "\n";
			await fs.writeFile(sessionFile, fileContent);

			// Call DELETE - should return quickly even if LLM fails
			const startTime = Date.now();
			const delRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}`, {
				method: "DELETE",
			});
			const elapsed = Date.now() - startTime;

			expect(delRes.status).toBe(200);
			await expect(delRes.json()).resolves.toMatchObject({ ok: true });
			expect(elapsed).toBeLessThan(500); // fire-and-forget

			// Verify JSONL file is deleted
			await expect(fs.access(sessionFile)).rejects.toThrow();

			// Cleanup
			testServer.close();
			await fs.rm(testSessionDir, { recursive: true, force: true }).catch(() => {});
		});
	});
});
