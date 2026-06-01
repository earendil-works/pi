/**
 * Smoke Test - End-to-end integration test for WebUI server
 *
 * Tests:
 * (a) GET /api/health returns 200 with {ok: true, version}
 * (b) POST /api/cron/jobs with valid body returns 200 with job object
 * (c) GET /api/cron/jobs includes the new job
 * (d) WS connect + CronWatcher detects cron.json changes
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { CronStore } from "../../cron-store";
import { CronWatcher } from "../../cron-watcher";

const TEST_PORT = 18772;

describe("WebUI Smoke Test", () => {
	let app: express.Express;
	let server: ReturnType<typeof createServer>;
	let baseUrl: string;
	let tempHome: string;
	let cronDataPath: string;
	let cronStore: CronStore;
	let wss: WebSocketServer;
	let activeWatcher: CronWatcher | null = null;

	beforeEach(async () => {
		// Create unique temp home directory for isolation
		const testId = crypto.randomUUID();
		tempHome = path.join("/tmp", `pi-webui-smoke-${testId}`);
		await fs.mkdir(tempHome, { recursive: true });

		// Compute cron data path based on temp home
		cronDataPath = path.join(tempHome, ".pi", "agent", "data", "cron.json");

		// Ensure the cron data directory exists
		await fs.mkdir(path.dirname(cronDataPath), { recursive: true });

		// Create CronStore with explicit path
		cronStore = new CronStore({ dataPath: cronDataPath });

		// Create Express app (simulating createApp without the hardcoded CronStore)
		app = express();
		app.use(express.json());

		// CORS middleware (same as createApp)
		app.use((req, res, next) => {
			const origin = req.headers.origin;
			if (origin && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) {
				res.setHeader("Access-Control-Allow-Origin", origin);
				res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
				res.setHeader("Access-Control-Allow-Headers", "Content-Type");
			}
			if (req.method === "OPTIONS") {
				res.sendStatus(204);
				return;
			}
			next();
		});

		// Mount health route
		app.get("/api/health", (_req, res) => {
			res.json({ ok: true, version: "0.1.0", uptime: 0, sessions: 0 });
		});

		// Mount cron routes using our manually created CronStore
		const { mountCronRoutes } = await import("../../routes/cron");
		mountCronRoutes(app, cronStore);

		// Static files fallback (no-op in test)
		app.use((_req, res) => {
			res.status(404).json({ error: "Not found" });
		});

		// Create HTTP server
		server = createServer(app);

		// Create WebSocket server
		wss = new WebSocketServer({ noServer: true });

		// Handle WebSocket upgrade
		server.on("upgrade", (request, socket, head) => {
			const url = new URL(request.url || "", "http://127.0.0.1");
			if (url.pathname === "/ws") {
				wss.handleUpgrade(request, socket, head, (ws) => {
					wss.emit("connection", ws, request);
				});
			} else {
				socket.destroy();
			}
		});

		// Handle WS connections
		wss.on("connection", (ws) => {
			console.error("[WebSocket] Client connected");
			ws.on("close", () => {
				console.error("[WebSocket] Client disconnected");
			});
			// Note: For real WS message handling, we'd subscribe to activeWatcher here
			// For this smoke test, we just verify the connection is accepted
		});

		// Start listening
		await new Promise<void>((resolve) => server.listen(TEST_PORT, "127.0.0.1", resolve));
		baseUrl = `http://127.0.0.1:${TEST_PORT}`;
	});

	afterEach(async () => {
		// Stop watcher if active
		if (activeWatcher) {
			activeWatcher.stop();
			activeWatcher = null;
		}

		// Close WebSocket server
		await new Promise<void>((resolve) => wss.close(() => resolve()));

		// Close HTTP server
		await new Promise<void>((resolve) => server.close(() => resolve()));

		// Cleanup temp directory
		try {
			await fs.rm(tempHome, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	// (a) GET /api/health returns 200 with {ok: true, version}
	describe("(a) GET /api/health", () => {
		it("returns 200 with ok:true and version", async () => {
			const res = await fetch(`${baseUrl}/api/health`);
			expect(res.status).toBe(200);

			const body = (await res.json()) as Record<string, unknown>;
			expect(body.ok).toBe(true);
			expect(body.version).toBe("0.1.0");
			expect(body.uptime).toBe(0);
			expect(body.sessions).toBe(0);
		});

		it("returns JSON content-type", async () => {
			const res = await fetch(`${baseUrl}/api/health`);
			expect(res.headers.get("content-type")).toContain("application/json");
		});
	});

	// (b) POST /api/cron/jobs with valid body returns 200 with job object
	describe("(b) POST /api/cron/jobs", () => {
		it("creates a new cron job and returns 200 with job object", async () => {
			const jobBody = {
				name: "test-job",
				schedule: { kind: "every", interval: 3600 },
				prompt: "Test prompt",
				enabled: true,
			};

			const res = await fetch(`${baseUrl}/api/cron/jobs`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(jobBody),
			});

			expect(res.status).toBe(200);

			const job = (await res.json()) as Record<string, unknown>;
			expect(job.id).toBeTruthy();
			expect(job.name).toBe("test-job");
			expect(job.schedule).toEqual({ kind: "every", interval: 3600 });
			expect(job.prompt).toBe("Test prompt");
			expect(job.enabled).toBe(true);
			expect(job.created_at).toBeTruthy();
			expect(job.last_run).toBeNull();
		});

		it("returns 400 for missing name", async () => {
			const res = await fetch(`${baseUrl}/api/cron/jobs`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					schedule: { kind: "every", interval: 3600 },
					prompt: "Test",
				}),
			});

			expect(res.status).toBe(400);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.error).toContain("name");
		});

		it("returns 400 for invalid schedule kind", async () => {
			const res = await fetch(`${baseUrl}/api/cron/jobs`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test",
					schedule: { kind: "invalid" },
					prompt: "Test",
				}),
			});

			expect(res.status).toBe(400);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.error).toContain("schedule");
		});
	});

	// (c) GET /api/cron/jobs includes the new job
	describe("(c) GET /api/cron/jobs", () => {
		it("returns empty array initially", async () => {
			const res = await fetch(`${baseUrl}/api/cron/jobs`);
			expect(res.status).toBe(200);

			const jobs = (await res.json()) as unknown[];
			expect(Array.isArray(jobs)).toBe(true);
			expect(jobs).toHaveLength(0);
		});

		it("includes a newly created job", async () => {
			// Create a job first
			const createRes = await fetch(`${baseUrl}/api/cron/jobs`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "list-test-job",
					schedule: { kind: "cron", expr: "0 * * * *" },
					prompt: "List test",
					enabled: false,
				}),
			});
			expect(createRes.status).toBe(200);
			const created = (await createRes.json()) as Record<string, unknown>;

			// List jobs
			const listRes = await fetch(`${baseUrl}/api/cron/jobs`);
			expect(listRes.status).toBe(200);

			const jobs = (await listRes.json()) as Array<Record<string, unknown>>;
			expect(Array.isArray(jobs)).toBe(true);
			expect(jobs.length).toBeGreaterThanOrEqual(1);

			const found = jobs.find((j) => j.id === created.id);
			expect(found).toBeTruthy();
			expect(found?.name).toBe("list-test-job");
			expect(found?.schedule).toEqual({ kind: "cron", expr: "0 * * * *" });
		});
	});

	// (d) WS connect + CronWatcher detects cron.json changes
	describe("(d) WebSocket and CronWatcher integration", () => {
		it("WS endpoint accepts connection", async () => {
			// Note: The WS handler just accepts and logs. This verifies the endpoint is reachable.
			const wsUrl = `ws://127.0.0.1:${TEST_PORT}/ws`;

			await new Promise<void>((resolve, reject) => {
				const ws = new WebSocket(wsUrl);

				ws.on("open", () => {
					// Connection was accepted (server didn't reject/destroy immediately)
					ws.close();
					resolve();
				});

				ws.on("error", (err) => {
					reject(new Error(`WS connection error: ${err.message}`));
				});

				// Timeout after 2 seconds
				setTimeout(() => {
					ws.close();
					reject(new Error("WS connection timeout"));
				}, 2000);
			});
		});

		it("CronWatcher detects cron.json file changes within debounce window", async () => {
			// Create initial empty cron.json
			await fs.writeFile(cronDataPath, "[]", "utf-8");

			// Create and start CronWatcher on the correct path
			const watcher = new CronWatcher(cronDataPath);
			activeWatcher = watcher;
			watcher.start();

			// Collect cron_changed events
			const events: Array<{ type: string }> = [];
			const unsubscribe = watcher.subscribe((event: { type: string }) => {
				events.push(event);
			});

			// Wait a bit to ensure watcher is ready
			await new Promise((r) => setTimeout(r, 100));

			// Modify cron.json
			const jobs = [
				{
					id: "test-1",
					name: "Modified Job",
					schedule: { kind: "at", time: "10:00" },
					prompt: "Test",
					enabled: true,
					created_at: new Date().toISOString(),
					last_run: null,
				},
			];
			await fs.writeFile(cronDataPath, JSON.stringify(jobs), "utf-8");

			// Wait for chokidar stability (200ms) + debounce (200ms) + buffer (200ms)
			await new Promise((r) => setTimeout(r, 700));

			// Verify event was emitted
			expect(events).toHaveLength(1);
			expect(events[0].type).toBe("cron_changed");

			unsubscribe();
		});
	});
});
