import { describe, it, expect } from "vitest";
import express from "express";
import { createServer } from "node:http";

describe("Memory REST API route skeleton", () => {
	it("6 routes are registered and return 501", async () => {
		const { mountMemoryRoutes } = await import("../routes/memory");
		const app = express();
		app.use(express.json());
		mountMemoryRoutes(app, {
			dbPath: "/tmp/nonexistent.db",
			atomsDir: "/tmp/nonexistent-atoms",
			settings: {},
			callLlm: async () => "",
		});
		const server = createServer(app);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		try {
			const r1 = await fetch(`http://127.0.0.1:${port}/api/memory`);
			expect(r1.status).toBe(501);
			const r2 = await fetch(`http://127.0.0.1:${port}/api/memory/abc`);
			expect(r2.status).toBe(501);
			const r3 = await fetch(`http://127.0.0.1:${port}/api/memory/abc`, { method: "PATCH" });
			expect(r3.status).toBe(501);
			const r4 = await fetch(`http://127.0.0.1:${port}/api/memory/abc/archive`, { method: "POST" });
			expect(r4.status).toBe(501);
			const r5 = await fetch(`http://127.0.0.1:${port}/api/memory/search`, { method: "POST" });
			expect(r5.status).toBe(501);
			const r6 = await fetch(`http://127.0.0.1:${port}/api/memory/stats`);
			expect(r6.status).toBe(501);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});