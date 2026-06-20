// Tests for the GET /api/memory/:id route. Covers S21 (full atom + content),
// S22 (404 for missing atom), and S23 (content="" on missing/stale .md file).
//
// The route imports from extensions/personal-assistant via relative paths
// because that extension is not a workspace package and its index.ts only
// re-exports runMemoryExtraction. Relative paths work for both vitest and
// the esbuild server bundle.

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
	mountMemoryRoutes,
	registerGetMemoryById,
	registerGetMemoryList,
	registerGetMemoryStats,
	registerPatchMemory,
	registerPostArchive,
	type MemoryDeps,
} from "../routes/memory.ts";

describe("GET /api/memory/:id", () => {
	let app: express.Express;
	let deps: MemoryDeps;
	let dbPath: string;
	let atomsDir: string;
	let tmpDir: string;
	let server: ReturnType<express.Express["listen"]>;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-routes-test-"));
		dbPath = path.join(tmpDir, "memory.db");
		atomsDir = path.join(tmpDir, "atoms");
		await fs.mkdir(atomsDir, { recursive: true });

		// Initialize an empty DB with the v2 schema by constructing an
		// index, calling init(), and closing immediately. Per-request
		// indexes are opened fresh by the route, so this just seeds
		// the schema and frees the file handle.
		const { MemoryIndex } = await import(
			"../../../../extensions/personal-assistant/storage.ts"
		);
		const seed = new MemoryIndex(dbPath);
		await seed.init();
		seed.close();

		app = express();
		deps = { dbPath, atomsDir };
		registerGetMemoryById(app, deps);
		// Bind to 127.0.0.1 to avoid IPv6 (`::`) default on dual-stack hosts.
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", () => resolve()));
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	const fetchAt = async (
		routePath: string,
	): Promise<{ status: number; body: Record<string, unknown> }> => {
		const addr = server.address();
		if (!addr || typeof addr === "string") {
			throw new Error("server has no address");
		}
		const res = await fetch(`http://127.0.0.1:${addr.port}${routePath}`);
		const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		return { status: res.status, body };
	};

	const insertTestAtom = async (
		overrides: Record<string, unknown> = {},
	): Promise<Record<string, unknown>> => {
		const { MemoryIndex } = await import(
			"../../../../extensions/personal-assistant/storage.ts"
		);
		const { computeContentHash } = await import(
			"../../../../extensions/personal-assistant/file-store.ts"
		);
		const idx = new MemoryIndex(dbPath);
		await idx.init();
		try {
			// Default content + fingerprint. The hash is computed from
			// the literal content so a matching .md file is valid by
			// default; per-test overrides can pin a stale fingerprint
			// to force the "hash mismatch" path.
			const content = "Body content here";
			const fingerprint = computeContentHash(content);
			const atom = {
				id: "test-atom-id",
				type: "rule",
				title: "Test",
				content,
				summary: "summary text",
				tags: ["test"],
				importance: 0.5,
				strength: 0.5,
				access_count: 0,
				version: 1,
				is_latest: 1,
				parent_id: null,
				superseded_at: null,
				archived: 0,
				created_at: Date.now(),
				updated_at: Date.now(),
				last_access: null,
				content_fingerprint: fingerprint,
				source_session: null,
				...overrides,
			};
			// MemoryIndex stores vectors as Float32Array(1024); the
			// embedding can be arbitrary for these tests since we never
			// run a vector search.
			const embedding = new Array<number>(1024).fill(0.01);
			await idx.insertAtom(atom as never, embedding);
			return atom;
		} finally {
			idx.close();
		}
	};

	const writeAtomFile = async (atom: Record<string, unknown>): Promise<string> => {
		const dir = path.join(atomsDir, atom.type as string);
		await fs.mkdir(dir, { recursive: true });
		const fp = path.join(dir, `${atom.id as string}.md`);
		const fm = `id: ${atom.id as string}\ntype: ${atom.type as string}\ntitle: ${atom.title as string}\ncontent_fingerprint: ${atom.content_fingerprint as string}\n`;
		await fs.writeFile(fp, `---\n${fm}\n---\n\n${atom.content as string}\n`, "utf8");
		return fp;
	};

	it("returns 404 if atom not found", async () => {
		const res = await fetchAt("/api/memory/nonexistent");
		expect(res.status).toBe(404);
		expect(String(res.body.error)).toContain("not found");
	});

	it("returns atom JSON with content from .md file", async () => {
		const atom = await insertTestAtom();
		await writeAtomFile(atom);
		const res = await fetchAt(`/api/memory/${atom.id as string}`);
		expect(res.status).toBe(200);
		expect(res.body.id).toBe(atom.id);
		expect(res.body.title).toBe(atom.title);
		expect(res.body.content).toBe("Body content here");
	});

	it("returns content='' if .md file missing (graceful degradation)", async () => {
		const atom = await insertTestAtom();
		// Intentionally do NOT call writeAtomFile — the file is absent.
		const res = await fetchAt(`/api/memory/${atom.id as string}`);
		expect(res.status).toBe(200);
		expect(res.body.id).toBe(atom.id);
		expect(res.body.content).toBe("");
	});

	it("returns content='' if .md file hash mismatch (stale)", async () => {
		const atom = await insertTestAtom();
		await writeAtomFile(atom);
		// Overwrite the file with content whose hash will not match
		// the DB fingerprint. The DB row keeps the original fingerprint,
		// so readAtomFromFile should reject the file on the hash check
		// and the route should return content="".
		const fp = path.join(atomsDir, atom.type as string, `${atom.id as string}.md`);
		await fs.writeFile(fp, "---\nid: bad\n---\n\nCORRUPTED CONTENT\n", "utf8");
		const res = await fetchAt(`/api/memory/${atom.id as string}`);
		expect(res.status).toBe(200);
		expect(res.body.content).toBe("");
	});
});

// Tests for the GET /api/memory list endpoint (Task 7.1) and
// mountMemoryRoutes DI factory. Covers S25 (list), S26 (filter by
// type/tag/archived), and S27 (limit/offset pagination).
describe("GET /api/memory", () => {
	let app: express.Express;
	let deps: MemoryDeps;
	let dbPath: string;
	let atomsDir: string;
	let tmpDir: string;
	let server: ReturnType<express.Express["listen"]>;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-list-"));
		dbPath = path.join(tmpDir, "memory.db");
		atomsDir = path.join(tmpDir, "atoms");
		await fs.mkdir(atomsDir, { recursive: true });

		// Initialize an empty DB with the v2 schema so per-request
		// MemoryIndex instances have something to open.
		const { MemoryIndex } = await import(
			"../../../../extensions/personal-assistant/storage.ts"
		);
		const seed = new MemoryIndex(dbPath);
		await seed.init();
		seed.close();

		app = express();
		// settings + callLlm are unused by the list endpoint but
		// required by the extended MemoryDeps interface (Tasks 7.6/7.7
		// will consume them). Cast through unknown to avoid a noUnusedLocals
		// complaint while keeping the deps object structurally complete.
		deps = {
			dbPath,
			atomsDir,
			settings: {} as never,
			callLlm: async () => "",
		};
		registerGetMemoryList(app, deps);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", () => resolve()));
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	const fetchAt = async (
		routePath: string,
	): Promise<{ status: number; body: unknown }> => {
		const addr = server.address();
		if (!addr || typeof addr === "string") {
			throw new Error("server has no address");
		}
		const res = await fetch(`http://127.0.0.1:${addr.port}${routePath}`);
		const body = (await res.json().catch(() => ({}))) as unknown;
		return { status: res.status, body };
	};

	const insertAtom = async (overrides: Record<string, unknown> = {}): Promise<void> => {
		const { MemoryIndex } = await import(
			"../../../../extensions/personal-assistant/storage.ts"
		);
		const idx = new MemoryIndex(dbPath);
		await idx.init();
		try {
			const atom = {
				id: randomUUID(),
				type: "rule",
				title: "T",
				content: "C",
				summary: "S",
				tags: ["a"],
				importance: 0.5,
				strength: 0.5,
				access_count: 0,
				version: 1,
				is_latest: 1,
				parent_id: null,
				superseded_at: null,
				archived: 0,
				created_at: Date.now(),
				updated_at: Date.now(),
				last_access: null,
				content_fingerprint: randomUUID().slice(0, 16),
				source_session: null,
				...overrides,
			};
			const embedding = new Array<number>(1024).fill(0.01);
			await idx.insertAtom(atom as never, embedding);
		} finally {
			idx.close();
		}
	};

	it("returns empty array if no atoms", async () => {
		const res = await fetchAt("/api/memory");
		expect(res.status).toBe(200);
		expect(res.body).toEqual([]);
	});

	it("returns all active atoms by default", async () => {
		await insertAtom({ type: "rule", content_fingerprint: "fp-rule" });
		await insertAtom({ type: "fact", content_fingerprint: "fp-fact" });
		const res = await fetchAt("/api/memory");
		expect(res.status).toBe(200);
		expect(res.body).toHaveLength(2);
	});

	it("filters by type", async () => {
		await insertAtom({ type: "rule", content_fingerprint: "fp-r" });
		await insertAtom({ type: "fact", content_fingerprint: "fp-f" });
		const res = await fetchAt("/api/memory?type=rule");
		const body = res.body as Array<{ type: string }>;
		expect(body).toHaveLength(1);
		expect(body[0]?.type).toBe("rule");
	});

	it("filters by tag", async () => {
		await insertAtom({ tags: ["alpha"], content_fingerprint: "fp1" });
		await insertAtom({ tags: ["beta"], content_fingerprint: "fp2" });
		const res = await fetchAt("/api/memory?tag=alpha");
		const body = res.body as Array<{ tags: string[] }>;
		expect(body).toHaveLength(1);
		expect(body[0]?.tags).toContain("alpha");
	});

	it("excludes archived atoms by default", async () => {
		await insertAtom({ content_fingerprint: "fp-active" });
		await insertAtom({ content_fingerprint: "fp-archived", archived: 1 });
		const res = await fetchAt("/api/memory");
		expect(res.body).toHaveLength(1);
	});

	it("includes archived atoms when archived=all", async () => {
		await insertAtom({ content_fingerprint: "fp-active" });
		await insertAtom({ content_fingerprint: "fp-archived", archived: 1 });
		const res = await fetchAt("/api/memory?archived=all");
		const body = res.body as unknown[];
		expect(body.length).toBeGreaterThanOrEqual(1);
	});

	it("respects limit and offset", async () => {
		for (let i = 0; i < 5; i++) {
			await insertAtom({ content_fingerprint: `fp-${i}` });
		}
		const res = await fetchAt("/api/memory?limit=2&offset=1");
		expect(res.body).toHaveLength(2);
	});
});

describe("mountMemoryRoutes", () => {
	it("registers both GET / and GET /:id routes", () => {
		const app = express();
		const deps: MemoryDeps = {
			dbPath: "/nonexistent",
			atomsDir: "/nonexistent",
			settings: {} as never,
			callLlm: async () => "",
		};
		mountMemoryRoutes(app, deps);
		const routes: string[] = [];
		const router = app._router;
		if (router && Array.isArray(router.stack)) {
			for (const layer of router.stack as Array<{ route?: { path: string; methods: Record<string, boolean> } }>) {
				if (layer.route) {
					const method = Object.keys(layer.route.methods)[0] ?? "unknown";
					routes.push(`${method} ${layer.route.path}`);
				}
			}
		}
		expect(routes).toContain("get /api/memory");
		expect(routes.some((r) => r.startsWith("get /api/memory/"))).toBe(true);
	});
});

// Tests for the PATCH /api/memory/:id edit endpoint (Task 7.5).
// Covers S28 (tags are unioned), S29 (embedding recomputed), S30
// (version increments) and R30-R32 (merge semantics + clamp + version+1).
//
// embedText is called with a short timeout via deps.embedTimeoutMs so the
// suite stays fast even when ollama is unreachable — embedText returns null
// in that case, which the route handles by updating the DB and .md file
// but skipping the vector (per Decision 7).
describe("PATCH /api/memory/:id", () => {
	let app: express.Express;
	let deps: MemoryDeps;
	let dbPath: string;
	let atomsDir: string;
	let tmpDir: string;
	let server: ReturnType<express.Express["listen"]>;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-patch-"));
		dbPath = path.join(tmpDir, "memory.db");
		atomsDir = path.join(tmpDir, "atoms");
		await fs.mkdir(atomsDir, { recursive: true });

		// Seed an empty v2-schema DB.
		const { MemoryIndex } = await import(
			"../../../../extensions/personal-assistant/storage.ts"
		);
		const seed = new MemoryIndex(dbPath);
		await seed.init();
		seed.close();

		app = express();
		app.use(express.json());
		deps = {
			dbPath,
			atomsDir,
			settings: {} as never,
			callLlm: async () => "",
			// Short embed timeout — ollama is unreachable in CI, so
			// embedText resolves to null in <embedTimeoutMs ms and the
			// route continues with the DB + .md update.
			embedTimeoutMs: 200,
		};
		registerPatchMemory(app, deps);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", () => resolve()));
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	const fetchAt = async (
		routePath: string,
		init: { method?: string; body?: unknown } = {},
	): Promise<{ status: number; body: Record<string, unknown> }> => {
		const addr = server.address();
		if (!addr || typeof addr === "string") {
			throw new Error("server has no address");
		}
		const res = await fetch(`http://127.0.0.1:${addr.port}${routePath}`, {
			method: init.method ?? "GET",
			headers: { "Content-Type": "application/json" },
			body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
		});
		const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		return { status: res.status, body };
	};

	const insertAtom = async (
		overrides: Record<string, unknown> = {},
	): Promise<Record<string, unknown>> => {
		const { MemoryIndex } = await import(
			"../../../../extensions/personal-assistant/storage.ts"
		);
		const idx = new MemoryIndex(dbPath);
		await idx.init();
		try {
			const atom = {
				id: "atom-1",
				type: "rule",
				title: "T",
				content: "Original content",
				summary: "S",
				tags: ["existing"],
				importance: 0.5,
				strength: 0.5,
				access_count: 0,
				version: 1,
				is_latest: 1,
				parent_id: null,
				superseded_at: null,
				archived: 0,
				created_at: Date.now(),
				updated_at: Date.now(),
				last_access: null,
				content_fingerprint: "fp-orig-12345678",
				source_session: null,
				...overrides,
			};
			const embedding = new Array<number>(1024).fill(0.01);
			await idx.insertAtom(atom as never, embedding);
			return atom;
		} finally {
			idx.close();
		}
	};

	it("returns 404 if atom not found", async () => {
		const res = await fetchAt("/api/memory/nonexistent", {
			method: "PATCH",
			body: { tags: ["x"] },
		});
		expect(res.status).toBe(404);
		expect(String(res.body.error)).toContain("not found");
	});

	it("unions new tags with existing", async () => {
		await insertAtom();
		const res = await fetchAt("/api/memory/atom-1", {
			method: "PATCH",
			body: { tags: ["new-tag"] },
		});
		expect(res.status).toBe(200);
		const tags = res.body.tags as string[];
		expect(tags).toEqual(expect.arrayContaining(["existing", "new-tag"]));
		// Dedup: re-adding an existing tag must not duplicate it.
		const dup = await fetchAt("/api/memory/atom-1", {
			method: "PATCH",
			body: { tags: ["existing"] },
		});
		const dupTags = dup.body.tags as string[];
		expect(dupTags.filter((t) => t === "existing")).toHaveLength(1);
	});

	it("recomputes content fingerprint on content change", async () => {
		await insertAtom();
		const res = await fetchAt("/api/memory/atom-1", {
			method: "PATCH",
			body: { content: "Totally different content here" },
		});
		expect(res.status).toBe(200);
		expect(res.body.content).toBe("Totally different content here");
		expect(res.body.content_fingerprint).not.toBe("fp-orig-12345678");
	});

	it("clamps importance to [0,1]", async () => {
		await insertAtom();
		const high = await fetchAt("/api/memory/atom-1", {
			method: "PATCH",
			body: { importance: 1.5 },
		});
		expect(high.body.importance).toBe(1);
		const low = await fetchAt("/api/memory/atom-1", {
			method: "PATCH",
			body: { importance: -0.5 },
		});
		expect(low.body.importance).toBe(0);
	});

	it("increments version on update", async () => {
		await insertAtom();
		const res = await fetchAt("/api/memory/atom-1", {
			method: "PATCH",
			body: { tags: ["x"] },
		});
		expect(res.body.version).toBe(2);
	});
});

// Verifies the mount factory registers the PATCH handler alongside the
// GET handlers from 7.1 / 7.3. This guards against accidental removal of
// the registerPatchMemory call in mountMemoryRoutes.
describe("mountMemoryRoutes includes PATCH", () => {
	it("registers PATCH /api/memory/:id", () => {
		const app = express();
		const deps: MemoryDeps = {
			dbPath: "/nonexistent",
			atomsDir: "/nonexistent",
			settings: {} as never,
			callLlm: async () => "",
		};
		mountMemoryRoutes(app, deps);
		const routes: string[] = [];
		const router = app._router;
		if (router && Array.isArray(router.stack)) {
			for (const layer of router.stack as Array<{ route?: { path: string; methods: Record<string, boolean> } }>) {
				if (layer.route) {
					const method = Object.keys(layer.route.methods)[0] ?? "unknown";
					routes.push(`${method.toUpperCase()} ${layer.route.path}`);
				}
			}
		}
		expect(routes).toContain("PATCH /api/memory/:id");
	});
});

// Tests for the GET /api/memory/stats endpoint (Task 7.2).
// Covers S46 (returns total/archived/byType) and S47 (byType counts
// all 3 categories). The handler uses getRawDb() because getActiveAtoms
// filters archived rows out at SQL level — we need cross-status counts.
describe("GET /api/memory/stats", () => {
	let app: express.Express;
	let deps: MemoryDeps;
	let dbPath: string;
	let atomsDir: string;
	let tmpDir: string;
	let server: ReturnType<express.Express["listen"]>;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-stats-"));
		dbPath = path.join(tmpDir, "memory.db");
		atomsDir = path.join(tmpDir, "atoms");
		await fs.mkdir(atomsDir, { recursive: true });

		// Seed an empty v2-schema DB.
		const { MemoryIndex } = await import(
			"../../../../extensions/personal-assistant/storage.ts"
		);
		const seed = new MemoryIndex(dbPath);
		await seed.init();
		seed.close();

		app = express();
		deps = {
			dbPath,
			atomsDir,
			settings: {} as never,
			callLlm: async () => "",
		};
		registerGetMemoryStats(app, deps);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", () => resolve()));
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	const fetchAt = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
		const addr = server.address();
		if (!addr || typeof addr === "string") {
			throw new Error("server has no address");
		}
		const res = await fetch(`http://127.0.0.1:${addr.port}/api/memory/stats`);
		const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		return { status: res.status, body };
	};

	const insertAtom = async (overrides: Record<string, unknown> = {}): Promise<void> => {
		const { MemoryIndex } = await import(
			"../../../../extensions/personal-assistant/storage.ts"
		);
		const idx = new MemoryIndex(dbPath);
		await idx.init();
		try {
			const atom = {
				id: randomUUID(),
				type: "rule",
				title: "T",
				content: "C",
				summary: "S",
				tags: [],
				importance: 0.5,
				strength: 0.5,
				access_count: 0,
				version: 1,
				is_latest: 1,
				parent_id: null,
				superseded_at: null,
				archived: 0,
				created_at: Date.now(),
				updated_at: Date.now(),
				last_access: null,
				content_fingerprint: randomUUID().slice(0, 16),
				source_session: null,
				...overrides,
			};
			const embedding = new Array<number>(1024).fill(0.01);
			await idx.insertAtom(atom as never, embedding);
		} finally {
			idx.close();
		}
	};

	it("returns zeros for empty DB", async () => {
		const res = await fetchAt();
		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			total: 0,
			archived: 0,
			byType: { rule: 0, fact: 0, process: 0 },
		});
	});

	it("counts all active+archived atoms by type", async () => {
		for (let i = 0; i < 3; i++) {
			await insertAtom({ type: "rule", content_fingerprint: `fp-r-${i}` });
		}
		await insertAtom({ type: "fact", content_fingerprint: "fp-f-1" });

		const res = await fetchAt();
		expect(res.status).toBe(200);
		const body = res.body as { total: number; archived: number; byType: Record<string, number> };
		expect(body.total).toBe(4);
		expect(body.archived).toBe(0);
		expect(body.byType.rule).toBe(3);
		expect(body.byType.fact).toBe(1);
		expect(body.byType.process).toBe(0);
	});

	it("counts archived separately from total", async () => {
		const archivedId = randomUUID();
		await insertAtom({ id: archivedId, type: "rule", content_fingerprint: "fp-arch" });

		// Archive it via the index's own method (avoids raw SQL drift).
		const { MemoryIndex } = await import(
			"../../../../extensions/personal-assistant/storage.ts"
		);
		const idx = new MemoryIndex(dbPath);
		await idx.init();
		try {
			idx.markArchived(archivedId);
		} finally {
			idx.close();
		}

		const res = await fetchAt();
		expect(res.status).toBe(200);
		const body = res.body as { total: number; archived: number; byType: Record<string, number> };
		expect(body.total).toBe(1);
		expect(body.archived).toBe(1);
		expect(body.byType.rule).toBe(1);
	});
});

// Verifies the mount factory registers the stats handler alongside the
// other GET/PATCH handlers. Guards against accidental removal of the
// registerGetMemoryStats call in mountMemoryRoutes.
describe("mountMemoryRoutes includes stats", () => {
	it("registers GET /api/memory/stats", () => {
		const app = express();
		const deps: MemoryDeps = {
			dbPath: "/nonexistent",
			atomsDir: "/nonexistent",
			settings: {} as never,
			callLlm: async () => "",
		};
		mountMemoryRoutes(app, deps);
		const routes: string[] = [];
		const router = app._router;
		if (router && Array.isArray(router.stack)) {
			for (const layer of router.stack as Array<{ route?: { path: string; methods: Record<string, boolean> } }>) {
				if (layer.route) {
					const method = Object.keys(layer.route.methods)[0] ?? "unknown";
					routes.push(`${method.toUpperCase()} ${layer.route.path}`);
				}
			}
		}
		expect(routes).toContain("GET /api/memory/stats");
	});
});

// Tests for the POST /api/memory/:id/archive endpoint (Task 7.5).
// Covers S48 (archive sets archived=1 + deletes vector), S49 (unarchive
// sets archived=0, no vector recompute), and S50 (explicit body.archived
// overrides toggle). Reflects R44-R46.
//
// Architecture notes mirrored from memory.ts:
//   - markArchived writes an audit row; markUnarchived does not (per design).
//   - Vector is deleted only on archive (not on unarchive) — unarchive
//     leaves the row absent; if it was archived and the vector was already
//     deleted, no vector re-compute is performed.
//   - express.json() is applied per-route (not globally) so other handlers
//     stay payload-free unless they explicitly need a body.
describe("POST /api/memory/:id/archive", () => {
	let app: express.Express;
	let deps: MemoryDeps;
	let dbPath: string;
	let atomsDir: string;
	let tmpDir: string;
	let server: ReturnType<express.Express["listen"]>;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-archive-"));
		dbPath = path.join(tmpDir, "memory.db");
		atomsDir = path.join(tmpDir, "atoms");
		await fs.mkdir(atomsDir, { recursive: true });

		const { MemoryIndex } = await import(
			"../../../../extensions/personal-assistant/storage.ts"
		);
		const seed = new MemoryIndex(dbPath);
		await seed.init();
		seed.close();

		app = express();
		deps = {
			dbPath,
			atomsDir,
			settings: {} as never,
			callLlm: async () => "",
		};
		registerPostArchive(app, deps);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", () => resolve()));
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	const insertAtom = async (
		overrides: Record<string, unknown> = {},
	): Promise<Record<string, unknown>> => {
		const { MemoryIndex } = await import(
			"../../../../extensions/personal-assistant/storage.ts"
		);
		const idx = new MemoryIndex(dbPath);
		await idx.init();
		try {
			const atom = {
				id: "atom-arch",
				type: "fact",
				title: "T",
				content: "C",
				summary: "S",
				tags: [],
				importance: 0.5,
				strength: 0.5,
				access_count: 0,
				version: 1,
				is_latest: 1,
				parent_id: null,
				superseded_at: null,
				archived: 0,
				created_at: Date.now(),
				updated_at: Date.now(),
				last_access: null,
				content_fingerprint: "fp-arch-" + Math.random().toString(36).slice(2, 14),
				source_session: null,
				...overrides,
			};
			const embedding = new Array<number>(1024).fill(0.01);
			await idx.insertAtom(atom as never, embedding);
			return atom;
		} finally {
			idx.close();
		}
	};

	const fetchAt = async (
		routePath: string,
		opts: { method?: string; body?: unknown } = {},
	): Promise<{ status: number; body: Record<string, unknown> }> => {
		const addr = server.address();
		if (!addr || typeof addr === "string") {
			throw new Error("server has no address");
		}
		const res = await fetch(`http://127.0.0.1:${addr.port}${routePath}`, {
			method: opts.method ?? "GET",
			headers: { "Content-Type": "application/json" },
			body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
		});
		const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		return { status: res.status, body };
	};

	it("returns 404 if atom not found", async () => {
		const res = await fetchAt("/api/memory/nonexistent/archive", {
			method: "POST",
		});
		expect(res.status).toBe(404);
		expect(String(res.body.error)).toContain("not found");
	});

	it("archives active atom (toggle)", async () => {
		await insertAtom();
		const res = await fetchAt("/api/memory/atom-arch/archive", {
			method: "POST",
		});
		expect(res.status).toBe(200);
		expect(res.body.id).toBe("atom-arch");
		expect(res.body.archived).toBe(1);
	});

	it("deletes vector when archiving (R45)", async () => {
		await insertAtom();
		// Confirm vector exists before archiving.
		const { MemoryIndex } = await import(
			"../../../../extensions/personal-assistant/storage.ts"
		);
		const idx1 = new MemoryIndex(dbPath);
		await idx1.init();
		const before = idx1
			.getRawDb()
			.prepare(`SELECT 1 FROM memory_vectors WHERE id = ?`)
			.get("atom-arch");
		expect(before).toBeDefined();
		idx1.close();

		await fetchAt("/api/memory/atom-arch/archive", { method: "POST" });

		const idx2 = new MemoryIndex(dbPath);
		await idx2.init();
		const after = idx2
			.getRawDb()
			.prepare(`SELECT 1 FROM memory_vectors WHERE id = ?`)
			.get("atom-arch");
		expect(after).toBeUndefined();
		idx2.close();
	});

	it("unarchives archived atom (toggle)", async () => {
		await insertAtom({ archived: 1 });
		const res = await fetchAt("/api/memory/atom-arch/archive", {
			method: "POST",
		});
		expect(res.status).toBe(200);
		expect(res.body.archived).toBe(0);
	});

	it("explicit body.archived=true archives (S50)", async () => {
		await insertAtom();
		const res = await fetchAt("/api/memory/atom-arch/archive", {
			method: "POST",
			body: { archived: true },
		});
		expect(res.status).toBe(200);
		expect(res.body.archived).toBe(1);
	});

	it("explicit body.archived=false unarchives (S50, no vector recompute per R46)", async () => {
		await insertAtom({ archived: 1 });
		const res = await fetchAt("/api/memory/atom-arch/archive", {
			method: "POST",
			body: { archived: false },
		});
		expect(res.status).toBe(200);
		expect(res.body.archived).toBe(0);
	});

	it("persists archived state in DB after toggle archive", async () => {
		await insertAtom();
		await fetchAt("/api/memory/atom-arch/archive", { method: "POST" });

		const { MemoryIndex } = await import(
			"../../../../extensions/personal-assistant/storage.ts"
		);
		const idx = new MemoryIndex(dbPath);
		await idx.init();
		try {
			const row = idx.getAtom("atom-arch");
			expect(row).not.toBeNull();
			expect(row?.archived).toBe(1);
		} finally {
			idx.close();
		}
	});
});

// Verifies mountMemoryRoutes registers the POST archive handler alongside
// the other handlers. Guards against accidental removal of the
// registerPostArchive call.
describe("mountMemoryRoutes includes archive", () => {
	it("registers POST /api/memory/:id/archive", () => {
		const app = express();
		const deps: MemoryDeps = {
			dbPath: "/nonexistent",
			atomsDir: "/nonexistent",
			settings: {} as never,
			callLlm: async () => "",
		};
		mountMemoryRoutes(app, deps);
		const routes: string[] = [];
		const router = app._router;
		if (router && Array.isArray(router.stack)) {
			for (const layer of router.stack as Array<{ route?: { path: string; methods: Record<string, boolean> } }>) {
				if (layer.route) {
					const method = Object.keys(layer.route.methods)[0] ?? "unknown";
					routes.push(`${method.toUpperCase()} ${layer.route.path}`);
				}
			}
		}
		expect(routes).toContain("POST /api/memory/:id/archive");
	});
});
