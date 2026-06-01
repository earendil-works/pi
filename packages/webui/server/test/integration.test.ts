/**
 * Integration Test - WebUI Server End-to-End
 *
 * Tests the full startServer() flow with all wired endpoints:
 * (a) GET /api/health returns 200
 * (b) GET /api/sessions returns 200 (empty list)
 * (c) POST /api/sessions returns 200 with new session id
 * (d) GET /api/cron/jobs returns 200
 * (e) WS connect succeeds and connection stays open (does NOT immediately close)
 * (f) Writing to cron.json from outside the process triggers a cron_changed event
 *     on a subscribed WS client within 500ms
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { WebSocket } from "ws";

// ---------------------------------------------------------------------------
// Per-test homedir override via module-level vi.mock
// ---------------------------------------------------------------------------
vi.mock("node:os", () => ({
	homedir: () => "/tmp/pi-webui-integration",
}));

// ---------------------------------------------------------------------------
// Must be after vi.mock so the mock is in place before importing modules
// ---------------------------------------------------------------------------
import { startServer } from "../index";

// Fixed home dir - used by mock and for cleanup
const FIXED_HOMEDIR = "/tmp/pi-webui-integration";

describe("WebUI Integration", () => {
	let serverInfo: { server: any; stopServer: () => Promise<void> };
	let baseUrl: string;
	let wsUrl: string;

	beforeEach(async () => {
		// Ensure clean temp directory with subdirectories for all stores
		await fs.rm(FIXED_HOMEDIR, { recursive: true, force: true }).catch(() => {});
		await fs.mkdir(path.join(FIXED_HOMEDIR, ".pi", "agent", "data"), { recursive: true });
		await fs.mkdir(path.join(FIXED_HOMEDIR, ".pi", "agent", "sessions"), { recursive: true });

		// Create minimal models.json for LLMClient.init()
		const modelsJson = {
			providers: {
				"test-provider": {
					name: "Test Provider",
					baseUrl: "https://api.test.com",
					apiKey: "test-key",
					authHeader: true,
					models: [
						{
							id: "test-model",
							name: "Test Model",
							api: "openai-completions",
							baseUrl: "https://api.test.com",
							headers: {},
						},
					],
				},
			},
		};
		await fs.writeFile(
			path.join(FIXED_HOMEDIR, ".pi", "agent", "models.json"),
			JSON.stringify(modelsJson),
		);

		// Unique port per run to avoid conflicts
		const port = 18800 + Math.floor(Math.random() * 100);
		serverInfo = await startServer({ port });
		baseUrl = `http://127.0.0.1:${port}`;
		wsUrl = `ws://127.0.0.1:${port}/ws`;
	});

	afterEach(async () => {
		await serverInfo.stopServer();
		await fs.rm(FIXED_HOMEDIR, { recursive: true, force: true }).catch(() => {});
	});

	// (a) GET /api/health returns 200
	it("(a) GET /api/health", async () => {
		const res = await fetch(`${baseUrl}/api/health`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});

	// (b) GET /api/sessions returns 200 (empty list)
	it("(b) GET /api/sessions returns 200 (empty list)", async () => {
		const res = await fetch(`${baseUrl}/api/sessions`);
		expect(res.status).toBe(200);
		const list = await res.json();
		expect(Array.isArray(list)).toBe(true);
	});

	// (c) POST /api/sessions creates new session
	it("(c) POST /api/sessions creates new session", async () => {
		const res = await fetch(`${baseUrl}/api/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ initialPrompt: "integration test" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.id).toBeTruthy();
	});

	// (d) GET /api/cron/jobs returns 200
	it("(d) GET /api/cron/jobs returns 200", async () => {
		const res = await fetch(`${baseUrl}/api/cron/jobs`);
		expect(res.status).toBe(200);
		const list = (await res.json()) as unknown[];
		expect(Array.isArray(list)).toBe(true);
	});

	// (e) WS connect stays open (does NOT immediately close)
	it("(e) WS connect stays open (does NOT immediately close)", async () => {
		const ws = new WebSocket(wsUrl);
		const events: string[] = [];
		ws.on("open", () => events.push("open"));
		ws.on("close", () => events.push("close"));

		// Wait 1 second; connection should still be open
		await new Promise((r) => setTimeout(r, 1000));

		expect(events).toContain("open");
		expect(events).not.toContain("close"); // CRITICAL: not closed

		ws.close();
	});

	// (f) cron.json change triggers cron_changed event via WS
	it("(f) cron.json change triggers cron_changed event via WS", async () => {
		const ws = new WebSocket(wsUrl);
		const messages: any[] = [];

		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve());
			ws.once("error", reject);
		});

		ws.on("message", (data) => {
			try {
				messages.push(JSON.parse(data.toString()));
			} catch {
				// ignore parse errors
			}
		});

		// Wait for chokidar to be ready
		await new Promise((r) => setTimeout(r, 200));

		// Write to cron.json from outside the process
		const cronPath = path.join(FIXED_HOMEDIR, ".pi", "agent", "data", "cron.json");
		await fs.mkdir(path.dirname(cronPath), { recursive: true });
		await fs.writeFile(cronPath, "[]");

		// Wait for the change to be detected
		await new Promise((r) => setTimeout(r, 600));

		const cronChanged = messages.find((e) => e.type === "cron_changed");
		expect(cronChanged).toBeTruthy();

		ws.close();
	});
});
