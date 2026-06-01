import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
			expect(body).toEqual({ ok: true });

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
});
