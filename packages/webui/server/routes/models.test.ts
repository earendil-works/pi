import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer } from "node:http";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";

const TEST_PORT = 18772;

describe("GET /api/models", () => {
	let mountModelsRoutes: (app: express.Express) => void;
	let tempHomeDir: string;

	beforeEach(async () => {
		// Dynamic import
		const modelsModule = await import("../routes/models");
		mountModelsRoutes = modelsModule.mountModelsRoutes;

		// Create unique temp home dir for each test
		const testId = crypto.randomUUID();
		tempHomeDir = path.join("/tmp", `pi-models-test-${testId}`);
		await fs.mkdir(path.join(tempHomeDir, ".pi", "agent"), { recursive: true });
	});

	afterEach(async () => {
		// Cleanup temp directory
		try {
			await fs.rm(tempHomeDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	// Helper to create app with stubbed homeDir
	function createApp(homeDir: string): express.Express {
		const app = express();
		app.locals.homeDir = homeDir;
		mountModelsRoutes(app);
		return app;
	}

	// (a) Returns providers from valid models.json
	describe("(a) Returns providers from valid models.json", () => {
		let app: express.Express;
		let server: ReturnType<typeof createServer>;

		beforeEach(async () => {
			app = createApp(tempHomeDir);
			server = createServer(app);
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		});

		afterEach(() => {
			server.close();
		});

		it("returns 200 with providers array", async () => {
			// Write a valid models.json
			const modelsJsonPath = path.join(tempHomeDir, ".pi", "agent", "models.json");
			await fs.writeFile(modelsJsonPath, JSON.stringify({
				providers: [
					{
						name: "openai",
						models: [
							{ id: "gpt-4", name: "GPT-4" },
							{ id: "gpt-3.5", name: "GPT-3.5" },
						],
					},
					{
						name: "anthropic",
						models: [
							{ id: "claude-3", name: "Claude 3" },
						],
					},
				],
			}));

			const port = (server.address() as any).port;
			const res = await fetch(`http://127.0.0.1:${port}/api/models`);
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body).toHaveProperty("providers");
			expect(Array.isArray(body.providers)).toBe(true);
			expect(body.providers).toHaveLength(2);
			expect(body.providers[0]).toMatchObject({ name: "openai" });
			expect(body.providers[0].models).toHaveLength(2);
			expect(body.providers[1]).toMatchObject({ name: "anthropic" });
		});
	});

	// (b) Returns empty providers when file does not exist
	describe("(b) Returns empty providers when file does not exist", () => {
		let app: express.Express;
		let server: ReturnType<typeof createServer>;

		beforeEach(async () => {
			// Do NOT create models.json - file does not exist
			app = createApp(tempHomeDir);
			server = createServer(app);
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		});

		afterEach(() => {
			server.close();
		});

		it("returns 200 with empty providers array", async () => {
			const port = (server.address() as any).port;
			const res = await fetch(`http://127.0.0.1:${port}/api/models`);
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body).toHaveProperty("providers");
			expect(body.providers).toEqual([]);
		});
	});

	// (c) Returns empty providers when file is empty
	describe("(c) Returns empty providers when file is empty", () => {
		let app: express.Express;
		let server: ReturnType<typeof createServer>;

		beforeEach(async () => {
			const modelsJsonPath = path.join(tempHomeDir, ".pi", "agent", "models.json");
			await fs.writeFile(modelsJsonPath, "");

			app = createApp(tempHomeDir);
			server = createServer(app);
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		});

		afterEach(() => {
			server.close();
		});

		it("returns 200 with empty providers array", async () => {
			const port = (server.address() as any).port;
			const res = await fetch(`http://127.0.0.1:${port}/api/models`);
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body).toHaveProperty("providers");
			expect(body.providers).toEqual([]);
		});
	});

	// (d) Returns empty providers when JSON is corrupted
	describe("(d) Returns empty providers when JSON is corrupted", () => {
		let app: express.Express;
		let server: ReturnType<typeof createServer>;

		beforeEach(async () => {
			const modelsJsonPath = path.join(tempHomeDir, ".pi", "agent", "models.json");
			await fs.writeFile(modelsJsonPath, "{ this is not valid json }");

			app = createApp(tempHomeDir);
			server = createServer(app);
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		});

		afterEach(() => {
			server.close();
		});

		it("returns 200 with empty providers array", async () => {
			const port = (server.address() as any).port;
			const res = await fetch(`http://127.0.0.1:${port}/api/models`);
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body).toHaveProperty("providers");
			expect(body.providers).toEqual([]);
		});
	});
});
