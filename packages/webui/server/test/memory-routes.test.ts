import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer } from "node:http";
import * as fs from "node:fs/promises";
import path from "node:path";

describe("Memory REST API route skeleton", () => {
	it("remaining 1 placeholder route (stats) returns 501; GET list, GET :id, PATCH :id, POST :id/archive, POST search all implemented", async () => {
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
			// GET /api/memory is implemented in task 2.2; nonexistent db → init
			// creates a fresh empty index, so the endpoint returns 200 with [].
			const r1 = await fetch(`http://127.0.0.1:${port}/api/memory`);
			expect(r1.status).toBe(200);
			const body1 = await r1.json();
			expect(Array.isArray(body1)).toBe(true);
			expect(body1.length).toBe(0);
			// GET /api/memory/:id is implemented in task 2.3; unknown id → 404.
			const r2 = await fetch(`http://127.0.0.1:${port}/api/memory/abc`);
			expect(r2.status).toBe(404);
			const r3 = await fetch(`http://127.0.0.1:${port}/api/memory/abc`, { method: "PATCH" });
			expect(r3.status).toBe(404);
			const r4 = await fetch(`http://127.0.0.1:${port}/api/memory/abc/archive`, { method: "POST" });
			expect(r4.status).toBe(404);
			// POST /api/memory/search is implemented in task 2.6; nonexistent db +
			// empty query → 400.
			const r5 = await fetch(`http://127.0.0.1:${port}/api/memory/search`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(r5.status).toBe(400);
			const r6 = await fetch(`http://127.0.0.1:${port}/api/memory/stats`);
			expect(r6.status).toBe(501);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});

describe("(b) GET /api/memory list endpoint", () => {
	let app: express.Express;
	let server: ReturnType<typeof createServer>;
	let port: number;
	let tempDir: string;
	let dbPath: string;
	let atomsDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join("/tmp", "pi-memory-list-test-"));
		dbPath = path.join(tempDir, "test.db");
		atomsDir = path.join(tempDir, "atoms");
		await fs.mkdir(atomsDir, { recursive: true });
		// init index + insert test atoms
		const { MemoryIndex } = await import("@earendil-works/pi-personal-assistant");
		const idx = new MemoryIndex(dbPath);
		await idx.init();
		// active + archived + multiple types
		idx.upsertAtom({
			id: "a-1",
			type: "preference",
			title: "Use tabs not spaces",
			summary: "tab policy",
			tags: ["editor"],
			importance: 0.8,
			strength: 0.9,
			access_count: 0,
			last_access: "",
			created_at: "2025-01-01T00:00:00Z",
			updated_at: "2025-01-02T00:00:00Z",
			version: 1,
			archived: false,
			content: "# tabs",
			file_path: "",
			content_hash: "",
		});
		idx.upsertAtom({
			id: "a-2",
			type: "workflow",
			title: "Run tests first",
			summary: "test policy",
			tags: [],
			importance: 0.5,
			strength: 0.7,
			access_count: 0,
			last_access: "",
			created_at: "2025-01-01T00:00:00Z",
			updated_at: "2025-01-03T00:00:00Z",
			version: 1,
			archived: true,
			content: "# tests",
			file_path: "",
			content_hash: "",
		});
		idx.upsertAtom({
			id: "a-3",
			type: "preference",
			title: "Prefer dark mode",
			summary: "ui preference",
			tags: ["ui"],
			importance: 0.3,
			strength: 0.5,
			access_count: 0,
			last_access: "",
			created_at: "2025-01-01T00:00:00Z",
			updated_at: "2025-01-01T00:00:00Z",
			version: 1,
			archived: false,
			content: "# dark",
			file_path: "",
			content_hash: "",
		});
		idx.close();
		// mount
		const { mountMemoryRoutes } = await import("../routes/memory");
		app = express();
		app.use(express.json());
		mountMemoryRoutes(app, { dbPath, atomsDir, settings: {}, callLlm: async () => "" });
		server = createServer(app);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		port = (server.address() as { port: number }).port;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("default archived=active returns non-archived only", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/memory`);
		expect(res.status).toBe(200);
		const atoms = await res.json();
		expect(atoms.length).toBe(2);
		expect(atoms.every((a: any) => !a.archived)).toBe(true);
	});

	it("?archived=all returns all atoms", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/memory?archived=all`);
		expect(res.status).toBe(200);
		const atoms = await res.json();
		expect(atoms.length).toBe(3);
	});

	it("?type=preference&archived=active filters by type and archived", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/memory?type=preference&archived=active`);
		expect(res.status).toBe(200);
		const atoms = await res.json();
		expect(atoms.length).toBe(2);
		expect(atoms.every((a: any) => a.type === "preference" && !a.archived)).toBe(true);
	});
});

describe("(c) GET /api/memory/:id detail endpoint", () => {
	let app: express.Express;
	let server: ReturnType<typeof createServer>;
	let port: number;
	let tempDir: string;
	let dbPath: string;
	let atomsDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join("/tmp", "pi-memory-get-test-"));
		dbPath = path.join(tempDir, "test.db");
		atomsDir = path.join(tempDir, "atoms");
		await fs.mkdir(path.join(atomsDir, "preference"), { recursive: true });
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function setupIndexAndServer(atomOpts: { id: string; writeFile?: boolean; corruptHash?: boolean }) {
		const { MemoryIndex, writeAtomToFile } = await import("@earendil-works/pi-personal-assistant");
		const idx = new MemoryIndex(dbPath);
		await idx.init();
		const baseAtom = {
			id: atomOpts.id,
			type: "preference" as const,
			title: "Test",
			summary: "test summary",
			tags: [],
			importance: 0.5,
			strength: 0.7,
			access_count: 0,
			last_access: "",
			created_at: "2025-01-01T00:00:00Z",
			updated_at: "2025-01-01T00:00:00Z",
			version: 1,
			archived: false,
			content: "# test content",
			file_path: "",
			content_hash: "",
		};
		if (atomOpts.writeFile) {
			const { filePath, contentHash } = writeAtomToFile(baseAtom, atomsDir);
			idx.upsertAtom({ ...baseAtom, file_path: filePath, content_hash: contentHash });
		} else {
			idx.upsertAtom(baseAtom);
		}
		idx.close();
		const { mountMemoryRoutes } = await import("../routes/memory");
		app = express();
		app.use(express.json());
		mountMemoryRoutes(app, { dbPath, atomsDir, settings: {}, callLlm: async () => "" });
		server = createServer(app);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		port = (server.address() as { port: number }).port;
	}

	it("returns full atom with content when file exists", async () => {
		await setupIndexAndServer({ id: "a-1", writeFile: true });
		const res = await fetch(`http://127.0.0.1:${port}/api/memory/a-1`);
		expect(res.status).toBe(200);
		const atom = await res.json();
		expect(atom.id).toBe("a-1");
		expect(atom.content).toBe("# test content");
	});

	it("returns 404 when atom id does not exist", async () => {
		await setupIndexAndServer({ id: "a-1", writeFile: false });
		const res = await fetch(`http://127.0.0.1:${port}/api/memory/nonexistent`);
		expect(res.status).toBe(404);
	});

	it("returns content='' when .md file is missing (file_path set in db)", async () => {
		await setupIndexAndServer({ id: "a-1", writeFile: true });
		// delete the .md file
		const filePath = path.join(atomsDir, "preference", "test.md");
		await fs.unlink(filePath);
		const res = await fetch(`http://127.0.0.1:${port}/api/memory/a-1`);
		expect(res.status).toBe(200);
		const atom = await res.json();
		expect(atom.content).toBe("");
	});

	it("returns content='' when content_hash is corrupted", async () => {
		await setupIndexAndServer({ id: "a-1", writeFile: true });
		// mutate .md content on disk — sha256 won't match the hash stored in db
		const filePath = path.join(atomsDir, "preference", "test.md");
		await fs.writeFile(filePath, "# corrupted content", "utf-8");
		const res = await fetch(`http://127.0.0.1:${port}/api/memory/a-1`);
		expect(res.status).toBe(200);
		const atom = await res.json();
		expect(atom.content).toBe(""); // hash mismatch → empty
	});
});

describe("(f) POST /api/memory/search endpoint", () => {
	let app: express.Express;
	let server: ReturnType<typeof createServer>;
	let port: number;
	let tempDir: string;
	let dbPath: string;
	let atomsDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join("/tmp", "pi-memory-search-test-"));
		dbPath = path.join(tempDir, "test.db");
		atomsDir = path.join(tempDir, "atoms");
		await fs.mkdir(atomsDir, { recursive: true });
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function setup(callLlm: (prompt: string) => Promise<string>, atoms: any[]) {
		const { MemoryIndex, writeAtomToFile } = await import("@earendil-works/pi-personal-assistant");
		const idx = new MemoryIndex(dbPath);
		await idx.init();
		for (const atom of atoms) {
			const { filePath, contentHash } = writeAtomToFile(atom, atomsDir);
			idx.upsertAtom({ ...atom, file_path: filePath, content_hash: contentHash });
		}
		idx.close();
		const { mountMemoryRoutes } = await import("../routes/memory");
		app = express();
		app.use(express.json());
		mountMemoryRoutes(app, { dbPath, atomsDir, settings: {}, callLlm });
		server = createServer(app);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		port = (server.address() as { port: number }).port;
	}

	it("normal LLM response returns parsed keywords and search results", async () => {
		const callLlm = async () => JSON.stringify({
			keywords: ["database", "schema"],
			target_types: ["knowledge"],
		});
		const atoms = [
			{ id: "a-1", type: "knowledge" as const, title: "Database schema", summary: "postgres tables",
				tags: [], importance: 0.8, strength: 0.9, access_count: 0, last_access: "",
				created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z", version: 1, archived: false,
				content: "# schema", file_path: "", content_hash: "" },
			{ id: "a-2", type: "preference" as const, title: "Dark mode", summary: "ui",
				tags: [], importance: 0.3, strength: 0.5, access_count: 0, last_access: "",
				created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z", version: 1, archived: false,
				content: "# dark", file_path: "", content_hash: "" },
		];
		await setup(callLlm, atoms);
		const res = await fetch(`http://127.0.0.1:${port}/api/memory/search`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "tell me about database schema", topK: 5 }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.rewritten.keywords).toEqual(["database", "schema"]);
		expect(body.rewritten.target_types).toEqual(["knowledge"]);
		// embedding_available: false (no explicit settings.memory.embedding passed)
		expect(body.embedding_available).toBe(false);
		expect(body.results.length).toBeGreaterThanOrEqual(1);
		expect(body.results[0].atom.id).toBe("a-1");
	});

	it("callLlm throws → falls back to simpleKeywordExtraction, still 200", async () => {
		const callLlm = async () => { throw new Error("rate limit"); };
		const atoms = [
			{ id: "a-1", type: "knowledge" as const, title: "Database schema notes", summary: "",
				tags: [], importance: 0.5, strength: 0.7, access_count: 0, last_access: "",
				created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z", version: 1, archived: false,
				content: "# schema", file_path: "", content_hash: "" },
		];
		await setup(callLlm, atoms);
		const res = await fetch(`http://127.0.0.1:${port}/api/memory/search`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "database" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		// simpleKeywordExtraction returns query tokens as keywords
		expect(body.rewritten.keywords).toContain("database");
		expect(body.results.length).toBeGreaterThanOrEqual(1);
	});

	it("empty atom db returns {results: [], embedding_available: false}", async () => {
		const callLlm = async () => JSON.stringify({ keywords: ["x"], target_types: [] });
		await setup(callLlm, []);
		const res = await fetch(`http://127.0.0.1:${port}/api/memory/search`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "anything" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.results).toEqual([]);
		expect(body.embedding_available).toBe(false);
	});
});
