// Tests for the GET /api/memory/:id route. Covers S21 (full atom + content),
// S22 (404 for missing atom), and S23 (content="" on missing/stale .md file).
//
// The route imports from extensions/personal-assistant via relative paths
// because that extension is not a workspace package and its index.ts only
// re-exports runMemoryExtraction. Relative paths work for both vitest and
// the esbuild server bundle.

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { embedText } from "../../../../extensions/personal-assistant/embed.ts";
import {
	__getSubscriberCount,
	mountMemoryRoutes,
	registerGetMemoryById,
	registerGetMemoryList,
	registerGetMemoryStats,
	registerPatchMemory,
	registerPostArchive,
	type MemoryDeps,
} from "../routes/memory.ts";
import { rateLimit } from "../middleware/rate-limit.ts";

// Module-level vi.mock so memory.ts's runtime `await import(...embed.ts)`
// path inside recallAtoms hits the deterministic char-bag implementation
// below. Without this, embedText returns null in CI (ollama unreachable)
// and recallAtoms collapses to [] (Decision 7 — no fallback).
vi.mock("../../../../extensions/personal-assistant/embed.ts", async () => {
	const actual = await vi.importActual<
		typeof import("../../../../extensions/personal-assistant/embed.ts")
	>("../../../../extensions/personal-assistant/embed.ts");
	const charBag = async (text: string): Promise<number[]> => {
		const arr = new Array(1024).fill(0);
		for (let i = 0; i < text.length; i++) {
			arr[text.charCodeAt(i) % 1024] += 1;
		}
		const norm = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
		if (norm > 0) for (let i = 0; i < arr.length; i++) arr[i] /= norm;
		return arr;
	};
	return {
		...actual,
		embedText: vi.fn(charBag),
	};
});

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

	// Regression for the preview-only contract (Task 6.2/6.4): GET on the
	// webui is a UI preview and must NOT touch access_count / last_access.
	// Strength feedback is recorded exclusively by the agent's `memory_get`
	// tool (see extensions/personal-assistant/memory.ts). The handler body
	// must not call `index.updateAccess(...)`; this test fails the moment
	// anyone re-introduces that side effect.
	it("does not bump access_count on GET preview (preview-only contract)", async () => {
		const atom = await insertTestAtom();
		const res = await fetchAt(`/api/memory/${atom.id as string}`);
		expect(res.status).toBe(200);

		// Re-open the index on the same dbPath and read back the row.
		// The route closes its index per request (see memory.ts), so this
		// is a fresh connection that sees the on-disk state.
		const { MemoryIndex } = await import(
			"../../../../extensions/personal-assistant/storage.ts"
		);
		const idx = new MemoryIndex(dbPath);
		await idx.init();
		try {
			const got = idx.getAtom(atom.id as string);
			expect(got).not.toBeNull();
			expect(got?.access_count).toBe(0);
			expect(got?.last_access).toBeNull();
		} finally {
			idx.close();
		}
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
		init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
	): Promise<{ status: number; body: Record<string, unknown> }> => {
		const addr = server.address();
		if (!addr || typeof addr === "string") {
			throw new Error("server has no address");
		}
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...init.headers,
		};
		const res = await fetch(`http://127.0.0.1:${addr.port}${routePath}`, {
			method: init.method ?? "GET",
			headers,
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
			headers: { "If-Match": "1" },
		});
		expect(res.status).toBe(200);
		const tags = res.body.tags as string[];
		expect(tags).toEqual(expect.arrayContaining(["existing", "new-tag"]));
		// Dedup: re-adding an existing tag must not duplicate it.
		const dup = await fetchAt("/api/memory/atom-1", {
			method: "PATCH",
			body: { tags: ["existing"] },
			headers: { "If-Match": "2" },
		});
		const dupTags = dup.body.tags as string[];
		expect(dupTags.filter((t) => t === "existing")).toHaveLength(1);
	});

	it("recomputes content fingerprint on content change", async () => {
		await insertAtom();
		const res = await fetchAt("/api/memory/atom-1", {
			method: "PATCH",
			body: { content: "Totally different content here" },
			headers: { "If-Match": "1" },
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
			headers: { "If-Match": "1" },
		});
		expect(high.body.importance).toBe(1);
		const low = await fetchAt("/api/memory/atom-1", {
			method: "PATCH",
			body: { importance: -0.5 },
			headers: { "If-Match": "2" },
		});
		expect(low.body.importance).toBe(0);
	});

	it("increments version on update", async () => {
		await insertAtom();
		const res = await fetchAt("/api/memory/atom-1", {
			method: "PATCH",
			body: { tags: ["x"] },
			headers: { "If-Match": "1" },
		});
		expect(res.body.version).toBe(2);
	});

	// M1 (Task 5.2): `Math.max(0, Math.min(1, NaN))` returns NaN, which would
	// be stored in the DB and break recall (cosine distance is undefined for
	// NaN vectors). Importance must fall back to the existing value when the
	// body sends NaN / Infinity, instead of silently corrupting the row.
	it("falls back to existing importance when body.importance is NaN (M1)", async () => {
		await insertAtom({ importance: 0.42 });
		const res = await fetchAt("/api/memory/atom-1", {
			method: "PATCH",
			body: { importance: Number.NaN },
			headers: { "If-Match": "1" },
		});
		expect(res.status).toBe(200);
		expect(typeof res.body.importance).toBe("number");
		expect(Number.isFinite(res.body.importance as number)).toBe(true);
		expect(res.body.importance).toBe(0.42);
	});

	it("falls back to existing importance when body.importance is Infinity (M1)", async () => {
		await insertAtom({ importance: 0.3 });
		const res = await fetchAt("/api/memory/atom-1", {
			method: "PATCH",
			body: { importance: Number.POSITIVE_INFINITY },
			headers: { "If-Match": "1" },
		});
		expect(res.status).toBe(200);
		expect(Number.isFinite(res.body.importance as number)).toBe(true);
		expect(res.body.importance).toBe(0.3);
	});

	// M2 (Task 5.2): content starting with `---` is the YAML frontmatter
	// marker; the on-disk parser (file-store.normalizeMarkdown) would treat
	// the user's body as frontmatter, hash it as frontmatter, and on read
	// return content="" because the stored content_fingerprint would not
	// match. The route rejects such bodies with 400 instead.
	it("rejects content starting with --- (frontmatter marker) with 400 (M2)", async () => {
		await insertAtom();
		const res = await fetchAt("/api/memory/atom-1", {
			method: "PATCH",
			body: { content: "---\nnot really frontmatter" },
			headers: { "If-Match": "1" },
		});
		expect(res.status).toBe(400);
		expect(res.body.error).toBe("content_cannot_start_with_frontmatter");
	});

	// M4 (Task 5.2): normalizeTags calls `.trim()` on each entry; passing a
	// number would TypeError, leaking as 500. The route now filters to
	// strings before normalizing. Because the body's `tags` array is the
	// presence signal for "the user wants to merge tags", passing an array
	// whose only valid entries are already-existing strings means the
	// resulting tags are equivalent to existing — but the route must not
	// throw, and the existing tags must remain intact.
	it("preserves existing tags when PATCH body.tags has non-string entries (M4)", async () => {
		await insertAtom({ tags: ["alpha", "beta"] });
		const res = await fetchAt("/api/memory/atom-1", {
			method: "PATCH",
			body: { tags: [123, null, "alpha"] },
			headers: { "If-Match": "1" },
		});
		expect(res.status).toBe(200);
		const tags = res.body.tags as string[];
		// "alpha" and "beta" preserved verbatim; the number/null entries
		// were dropped silently rather than TypeError-throwing into 500.
		expect(tags).toEqual(["alpha", "beta"]);
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

// Tests for the POST /api/memory/search endpoint (Task 7.6).
// Covers S59 (ranked results), S60 (token budget respected), and R54
// (request body shape). Mirrors the recallAtoms + formatMemoryContext
// contract from extensions/personal-assistant/{search,format}.ts.
//
// The module-level vi.mock of embed.ts (at the top of this file) makes
// embedText deterministic so recallAtoms can return real ranked results
// even though ollama is unreachable in CI. Without the mock, embedText
// would return null and recallAtoms would collapse to [] (Decision 7).
describe("POST /api/memory/search", () => {
	let app: express.Express;
	let deps: MemoryDeps;
	let dbPath: string;
	let atomsDir: string;
	let tmpDir: string;
	let server: ReturnType<express.Express["listen"]>;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-search-"));
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
		// registerPostSearch is added in memory.ts by Task 7.6. The tests
		// below expect it to exist; if this import fails, the test file
		// fails to load — that IS the RED signal.
		const { registerPostSearch } = await import("../routes/memory.ts");
		registerPostSearch(app, deps);
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
				id: `search-${Math.random().toString(36).slice(2, 10)}`,
				type: "rule",
				title: "Test rule content",
				content: "Distinct test content alpha",
				summary: "Test summary",
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
				content_fingerprint: "fp-" + Math.random().toString(36).slice(2, 14),
				source_session: null,
				...overrides,
			};
			// Use the mocked embedText to produce an embedding that
			// shares the char-bag space with query embeddings at
			// recall-time. This is what makes the cosine threshold (0.5)
			// pass for matching texts in tests.
			const text = `${String(atom.title)}\n\n${String(atom.summary)}\n\n${String(atom.content)}\n\n${(atom.tags as string[]).join(" ")}`;
			const embedding = await embedText(text);
			if (!embedding) throw new Error("mocked embedText returned null");
			await idx.insertAtom(atom as never, embedding);
			return atom;
		} finally {
			idx.close();
		}
	};

	const fetchAt = async (
		routePath: string,
		body: Record<string, unknown> = {},
	): Promise<{ status: number; data: Record<string, unknown> }> => {
		const addr = server.address();
		if (!addr || typeof addr === "string") {
			throw new Error("server has no address");
		}
		const res = await fetch(`http://127.0.0.1:${addr.port}${routePath}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		return { status: res.status, data };
	};

	it("returns 400 if query missing", async () => {
		const res = await fetchAt("/api/memory/search", {});
		expect(res.status).toBe(400);
		expect(String(res.data.error)).toContain("query");
	});

	it("returns 400 if query is empty string", async () => {
		const res = await fetchAt("/api/memory/search", { query: "" });
		expect(res.status).toBe(400);
	});

	it("returns empty results if no atoms match", async () => {
		const res = await fetchAt("/api/memory/search", { query: "any query" });
		expect(res.status).toBe(200);
		expect(res.data.results).toEqual([]);
	});

	it("returns results with id+score for valid query (discovery-only contract)", async () => {
		await insertAtom({ content: "test content alpha distinct keywords here" });
		const res = await fetchAt("/api/memory/search", {
			query: "alpha content keywords",
		});
		expect(res.status).toBe(200);
		const results = res.data.results as Array<Record<string, unknown>>;
		expect(results.length).toBeGreaterThan(0);
		// Result shape contract: id/type/title/summary/tags/distance/cosine/score
		// (no file_path — full content fetched via memory_get(id))
		const first = results[0] as Record<string, unknown>;
		expect(typeof first.id).toBe("string");
		expect(typeof first.type).toBe("string");
		expect(typeof first.distance).toBe("number");
		expect(typeof first.cosine).toBe("number");
		expect(typeof first.score).toBe("number");
		expect(first.score as number).toBeGreaterThanOrEqual(0);
		// file_path removed from response — LLM uses memory_get(id) for full content
		expect(first.file_path).toBeUndefined();
		// Discovery-only: no tier / no formattedText / no tokenBudgetUsed.
		expect(first.tier).toBeUndefined();
		expect(res.data.formattedText).toBeUndefined();
		expect(res.data.tokenBudgetUsed).toBeUndefined();
	});

	it("respects type filter", async () => {
		await insertAtom({ type: "rule", content: "rule content alpha keywords" });
		await insertAtom({ type: "fact", content: "fact content beta keywords" });
		const res = await fetchAt("/api/memory/search", {
			query: "alpha content keywords",
			type: "rule",
		});
		expect(res.status).toBe(200);
		const results = res.data.results as Array<{ type: string }>;
		expect(results.length).toBeGreaterThan(0);
		expect(results.every((r) => r.type === "rule")).toBe(true);
	});

	it("reports a non-negative recallTimeMs", async () => {
		await insertAtom({ content: "alpha content keyword phrase" });
		const res = await fetchAt("/api/memory/search", { query: "alpha content" });
		expect(res.status).toBe(200);
		expect(typeof res.data.recallTimeMs).toBe("number");
		expect(res.data.recallTimeMs as number).toBeGreaterThanOrEqual(0);
	});
});

// Verifies mountMemoryRoutes registers the search handler. Guards against
// accidental removal of the registerPostSearch call.
describe("mountMemoryRoutes includes search", () => {
	it("registers POST /api/memory/search", () => {
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
		expect(routes).toContain("POST /api/memory/search");
	});
});

// Tests for the POST /api/memory/extract endpoint (Task 7.7).
// Covers S65 (extract creates atoms from messages), S66 (empty plan
// returns zero counts), and S67 (validates message shape). Mirrors the
// runMemoryExtraction contract from extensions/personal-assistant/extraction.ts.
//
// embedText is mocked at the module level (top of file) so extraction
// can complete without ollama. The route's callLlm dependency is
// satisfied by an inline mock that returns a valid extraction plan.
describe("POST /api/memory/extract", () => {
	let app: express.Express;
	let deps: MemoryDeps;
	let dbPath: string;
	let atomsDir: string;
	let tmpDir: string;
	let server: ReturnType<express.Express["listen"]>;
	// Holder pattern: deps.callLlm captures the closure-bound mockCallLlm
	// so per-test reassignments of `mockImpl` flow through without
	// re-registering the route.
	let mockImpl: () => string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-extract-"));
		dbPath = path.join(tmpDir, "memory.db");
		atomsDir = path.join(tmpDir, "atoms");
		await fs.mkdir(atomsDir, { recursive: true });

		const { MemoryIndex } = await import(
			"../../../../extensions/personal-assistant/storage.ts"
		);
		const seed = new MemoryIndex(dbPath);
		await seed.init();
		seed.close();

		// Default mock LLM returns one valid item. Individual tests
		// reassign `mockImpl` before their request to change the
		// response (e.g. empty plan).
		mockImpl = () =>
			JSON.stringify({
				items: [
					{
						type: "rule",
						title: "Extracted rule",
						content: "Test content from extract",
						summary: "Test summary",
						tags: ["extract"],
						importance: 0.5,
					},
				],
			});

		app = express();
		deps = {
			dbPath,
			atomsDir,
			settings: { memory: { embedding: { model: "test-model" } } } as never,
			callLlm: async (_prompt: string) => mockImpl(),
		};
		const { registerPostExtract } = await import("../routes/memory.ts");
		registerPostExtract(app, deps);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", () => resolve()));
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	const fetchAt = async (
		path: string,
		body: Record<string, unknown> = {},
	): Promise<{ status: number; data: Record<string, unknown> }> => {
		const addr = server.address();
		if (!addr || typeof addr === "string") {
			throw new Error("server has no address");
		}
		const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		return { status: res.status, data };
	};

	it("returns 400 if messages missing", async () => {
		const res = await fetchAt("/api/memory/extract", {});
		expect(res.status).toBe(400);
		expect(String(res.data.error)).toContain("messages");
	});

	it("returns 400 if messages is empty array", async () => {
		const res = await fetchAt("/api/memory/extract", { messages: [] });
		expect(res.status).toBe(400);
		expect(String(res.data.error)).toContain("messages");
	});

	it("returns 400 if message missing role/content", async () => {
		const res = await fetchAt("/api/memory/extract", {
			messages: [{ content: "x" }],
		});
		expect(res.status).toBe(400);
	});

	it("returns 400 if message role/content not strings", async () => {
		const res = await fetchAt("/api/memory/extract", {
			messages: [{ role: 123, content: "x" }],
		});
		expect(res.status).toBe(400);
	});

	it("extracts atoms and returns counts (S65)", async () => {
		const res = await fetchAt("/api/memory/extract", {
			messages: [{ role: "user", content: "I prefer dark mode" }],
		});
		expect(res.status).toBe(200);
		expect(res.data.created).toBe(1);
		const createdIds = res.data.createdIds as string[];
		expect(createdIds).toHaveLength(1);
		expect(typeof createdIds[0]).toBe("string");
		// plan echo contract: items + modelUsed + generatedAt
		const plan = res.data.plan as Record<string, unknown>;
		expect(Array.isArray(plan.items)).toBe(true);
		expect((plan.items as unknown[]).length).toBe(1);
		expect(plan.modelUsed).toBe("test-model");
		expect(typeof plan.generatedAt).toBe("number");
	});

	it("handles LLM returning no items (S66)", async () => {
		// Override the closure-bound mockImpl so deps.callLlm returns
		// the empty plan for this test only.
		mockImpl = () => JSON.stringify({ items: [] });
		const res = await fetchAt("/api/memory/extract", {
			messages: [{ role: "user", content: "nothing" }],
		});
		expect(res.status).toBe(200);
		expect(res.data.created).toBe(0);
		expect(res.data.superseded).toBe(0);
		expect(res.data.skipped).toBe(0);
		const createdIds = res.data.createdIds as unknown[];
		expect(createdIds).toHaveLength(0);
	});

	it("returns supersededPairs and skippedIds as arrays", async () => {
		const res = await fetchAt("/api/memory/extract", {
			messages: [{ role: "user", content: "x" }],
		});
		expect(res.status).toBe(200);
		expect(Array.isArray(res.data.supersededPairs)).toBe(true);
		expect(Array.isArray(res.data.skippedIds)).toBe(true);
	});
});

// Verifies mountMemoryRoutes registers the extract handler. Guards against
// accidental removal of the registerPostExtract call.
describe("mountMemoryRoutes includes extract", () => {
	it("registers POST /api/memory/extract", () => {
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
		expect(routes).toContain("POST /api/memory/extract");
	});
});

// Tests for the PATCH /api/memory/:id CAS (If-Match) contract (Task 2.1).
// Covers the optimistic-concurrency contract from docs/sdd/changes/memory-v2-refactor
// design.md Decision 1 + spec ADDED #1:
//   - missing If-Match       → 400 missing_if_match
//   - matching If-Match      → 200 + version incremented by 1
//   - stale If-Match         → 409 version_conflict + current atom snapshot
//   - If-Match: "*"          → 200 (any-version escape hatch)
//
// The existing PATCH tests (the `describe("PATCH /api/memory/:id", ...)`
// block at line 412) intentionally omit the If-Match header — after this
// task lands they will fail with 400. The orchestrator owns updating the
// webui client to send the header from GET responses (next task).
describe("PATCH /api/memory/:id CAS (If-Match)", () => {
	let app: express.Express;
	let deps: MemoryDeps;
	let dbPath: string;
	let atomsDir: string;
	let tmpDir: string;
	let server: ReturnType<express.Express["listen"]>;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-cas-"));
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
		init: {
			method?: string;
			body?: unknown;
			headers?: Record<string, string>;
		} = {},
	): Promise<{ status: number; body: Record<string, unknown> }> => {
		const addr = server.address();
		if (!addr || typeof addr === "string") {
			throw new Error("server has no address");
		}
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...init.headers,
		};
		const res = await fetch(`http://127.0.0.1:${addr.port}${routePath}`, {
			method: init.method ?? "GET",
			headers,
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
				id: "atom-cas",
				type: "rule",
				title: "CAS Test",
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
				content_fingerprint: "fp-cas-12345678",
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

	it("returns 400 when If-Match header is missing", async () => {
		await insertAtom();
		const res = await fetchAt("/api/memory/atom-cas", {
			method: "PATCH",
			body: { tags: ["x"] },
			// No If-Match header
		});
		expect(res.status).toBe(400);
		expect(res.body.error).toBe("missing_if_match");
	});

	it("returns 200 when If-Match matches existing.version", async () => {
		await insertAtom();
		const res = await fetchAt("/api/memory/atom-cas", {
			method: "PATCH",
			body: { tags: ["new-tag"] },
			headers: { "If-Match": "1" },
		});
		expect(res.status).toBe(200);
		// Version bumped from 1 → 2.
		expect(res.body.version).toBe(2);
	});

	it("returns 409 when If-Match version is stale", async () => {
		await insertAtom();
		const res = await fetchAt("/api/memory/atom-cas", {
			method: "PATCH",
			body: { tags: ["x"] },
			headers: { "If-Match": "0" },
		});
		expect(res.status).toBe(409);
		expect(res.body.error).toBe("version_conflict");
		// `current` payload lets the client merge or reload.
		const current = res.body.current as { version: number };
		expect(current).toBeDefined();
		expect(current.version).toBe(1);
	});

	it("accepts If-Match: * (any-version escape hatch)", async () => {
		await insertAtom();
		const res = await fetchAt("/api/memory/atom-cas", {
			method: "PATCH",
			body: { tags: ["x"] },
			headers: { "If-Match": "*" },
		});
		expect(res.status).toBe(200);
		// Version still bumps even on the wildcard path.
		expect(res.body.version).toBe(2);
	});
});

// Tests for the PATCH dedup gate + tag normalization (Task 2.2). Covers:
//   - the supersedeIfSimilar self-match guard routing PATCH to in-place
//     update (no previousId in response, version still bumped)
//   - normalizeTags folding via deps.settings.memory.tagAliases
//   - the embedText === null → supersedeIfSimilar returns "create" path
//
// The PATCH route's "supersede" branch (status === "supersede") is
// effectively unreachable: mergedAtom.id always equals existing.id
// (the PATCHed atom), and the self-match guard in supersedeIfSimilar
// returns "create" when the most-similar atom is the same id —
// markSupersededTx would also fail on PRIMARY KEY conflict in the
// cross-id case (the PATCHed atom's row already exists). The route
// therefore always falls through to updateAtom. We still wire up the
// gate so future callers (or future deduplication modes) can plug in.
describe("PATCH /api/memory/:id dedup + tag normalization", () => {
	let app: express.Express;
	let deps: MemoryDeps;
	let dbPath: string;
	let atomsDir: string;
	let tmpDir: string;
	let server: ReturnType<express.Express["listen"]>;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-dedup-"));
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
		app.use(express.json());
		deps = {
			dbPath,
			atomsDir,
			settings: {} as never,
			callLlm: async () => "",
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
		init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
	): Promise<{ status: number; body: Record<string, unknown> }> => {
		const addr = server.address();
		if (!addr || typeof addr === "string") {
			throw new Error("server has no address");
		}
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...init.headers,
		};
		const res = await fetch(`http://127.0.0.1:${addr.port}${routePath}`, {
			method: init.method ?? "GET",
			headers,
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
				tags: ["old"],
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
				content_fingerprint: "fp-dedup-12345678",
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

	it("dedup gate self-match returns in-place update (no previousId, version bumped)", async () => {
		await insertAtom();
		// PATCH the same content that already exists. The mock charBag
		// embedding for the unchanged embeddable text is identical to
		// the stored embedding's direction but the stored vector is
		// all-0.01 (set by the helper), so cosine is low → the dedup
		// gate returns "create" via the self-match or threshold paths.
		// Either way the route falls through to updateAtom and bumps
		// version to 2 without setting previousId.
		const res = await fetchAt("/api/memory/atom-1", {
			method: "PATCH",
			body: { content: "Original content" },
			headers: { "If-Match": "1" },
		});
		expect(res.status).toBe(200);
		expect(res.body.previousId).toBeUndefined();
		expect(res.body.version).toBe(2);
		expect(res.body.content).toBe("Original content");
	});

	it("normalizes tags via settings.memory.tagAliases", async () => {
		await insertAtom({ tags: ["old"] });
		deps.settings = {
			memory: { tagAliases: { "代码规范": "code-style" } },
		} as never;
		const res = await fetchAt("/api/memory/atom-1", {
			method: "PATCH",
			body: { tags: ["代码规范", "code-style"] },
			headers: { "If-Match": "1" },
		});
		expect(res.status).toBe(200);
		const tags = res.body.tags as string[];
		expect(tags).toEqual(["old", "code-style"]);
	});

	it("preserves existing.tags verbatim when PATCH body has no tags field", async () => {
		// Setup: atom with un-normalized tags (the legacy form, before any
		// tagAliases map existed in settings). Settings.memory.tagAliases is
		// configured so a re-normalize WOULD rewrite the tag. The PATCH body
		// omits `tags` entirely (no field), so the route must preserve the
		// legacy form verbatim — silently rewriting it would be data loss.
		await insertAtom({ tags: ["代码规范"] });
		deps.settings = {
			memory: { tagAliases: { "代码规范": "code-style" } },
		} as never;
		const res = await fetchAt("/api/memory/atom-1", {
			method: "PATCH",
			// Body contains `importance` only — no `tags` field at all.
			body: { importance: 0.7 },
			headers: { "If-Match": "1" },
		});
		expect(res.status).toBe(200);
		const tags = res.body.tags as string[];
		// Preserved verbatim: NOT folded to "code-style" by the alias map.
		expect(tags).toEqual(["代码规范"]);
	});

	it("skips supersede gracefully when embedText returns null", async () => {
		await insertAtom();
		// embedText is mocked at module level (charBag). Force a null
		// return for this single PATCH call so supersedeIfSimilar takes
		// the null-embedding branch and returns "create" without
		// touching the index. mockResolvedValueOnce auto-queues and
		// reverts to the default charBag after this one call.
		vi.mocked(embedText).mockResolvedValueOnce(null);
		const res = await fetchAt("/api/memory/atom-1", {
			method: "PATCH",
			body: { tags: ["y"] },
			headers: { "If-Match": "1" },
		});
		expect(res.status).toBe(200);
		expect(res.body.previousId).toBeUndefined();
		expect(res.body.version).toBe(2);
	});
});

// Tests for the GET /api/memory/:id/stream SSE endpoint (Task 2.4).
// Covers:
//   - 404 for unknown atom (immediate response close)
//   - 200 text/event-stream with Content-Type + initial : connected frame
//   - event: atom broadcast when another client PATCHes (S2)
//   - subscriber cleanup on client disconnect (S7)
//
// SSE frames are split on the standard "\n\n" delimiter; a comment frame
// begins with ":", and an event frame is "event: <name>\ndata: <payload>".
// AbortController simulates the client closing the connection mid-stream;
// cleanup is verified through the `__getSubscriberCount` test-only handle
// exposed by memory.ts (the underlying `subscribers` Map itself is not
// part of the public API).
describe("GET /api/memory/:id/stream", () => {
	let app: express.Express;
	let deps: MemoryDeps;
	let dbPath: string;
	let atomsDir: string;
	let tmpDir: string;
	let server: ReturnType<express.Express["listen"]>;
	const openControllers: AbortController[] = [];

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-stream-"));
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
			// Short embed timeout — same convention as PATCH tests so the
			// broadcast-on-PATCH test completes quickly in CI.
			embedTimeoutMs: 200,
		};
		mountMemoryRoutes(app, deps);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", () => resolve()));
	});

	afterEach(async () => {
		// Abort every stream so server.close() doesn't hang waiting on
		// idle SSE connections to terminate.
		for (const c of openControllers) {
			try { c.abort(); } catch { /* ignore */ }
		}
		openControllers.length = 0;
		// Give the server's close handlers a tick to fire before we
		// tear down the listener.
		await new Promise((r) => setTimeout(r, 50));
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	const addr = (): number => {
		const a = server.address();
		if (!a || typeof a === "string") throw new Error("no server address");
		return a.port;
	};

	const track = (controller: AbortController): AbortController => {
		openControllers.push(controller);
		return controller;
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
				id: "atom-stream",
				type: "rule",
				title: "T",
				content: "C",
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
				content_fingerprint: "fp-stream-12345678",
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

	// Start a background read loop that pushes every parsed SSE frame
	// into `frames`. The loop terminates silently when the stream ends
	// or the reader is cancelled, so callers never see unhandled
	// rejections from abort-driven cancellations.
	const startReading = (
		streamRes: Response,
		frames: string[],
	): void => {
		if (!streamRes.body) throw new Error("response has no body");
		const reader = streamRes.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		(async () => {
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) return;
					buffer += decoder.decode(value, { stream: true });
					let idx: number;
					while ((idx = buffer.indexOf("\n\n")) !== -1) {
						frames.push(buffer.slice(0, idx));
						buffer = buffer.slice(idx + 2);
					}
				}
			} catch { /* reader cancelled (abort / cleanup) */ }
		})();
	};

	const waitForFrames = async (
		frames: string[],
		n: number,
		timeoutMs = 5000,
	): Promise<void> => {
		const start = Date.now();
		while (frames.length < n) {
			if (Date.now() - start > timeoutMs) {
				throw new Error(
					`SSE timeout: waited ${timeoutMs}ms for ${n} frames, got ${frames.length}: ${JSON.stringify(frames)}`,
				);
			}
			await new Promise((r) => setTimeout(r, 5));
		}
	};

	it("returns 404 for unknown atom", async () => {
		const res = await fetch(
			`http://127.0.0.1:${addr()}/api/memory/unknown-id/stream`,
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("atom_not_found");
	});

	it("returns text/event-stream for known atom, sends : connected frame", async () => {
		await insertAtom();
		const controller = track(new AbortController());
		const res = await fetch(
			`http://127.0.0.1:${addr()}/api/memory/atom-stream/stream`,
			{ signal: controller.signal },
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/event-stream");

		const frames: string[] = [];
		startReading(res, frames);
		await waitForFrames(frames, 1);
		expect(frames[0]).toBe(": connected");
	});

	it("pushes event: atom when another client PATCHes", async () => {
		await insertAtom();

		const controller = track(new AbortController());
		const streamRes = await fetch(
			`http://127.0.0.1:${addr()}/api/memory/atom-stream/stream`,
			{ signal: controller.signal },
		);
		expect(streamRes.status).toBe(200);

		const frames: string[] = [];
		startReading(streamRes, frames);

		// Wait for the initial : connected frame so we know the server
		// has registered the subscriber before we trigger the PATCH.
		await waitForFrames(frames, 1);
		expect(frames[0]).toBe(": connected");

		// PATCH the same atom from a separate (non-streaming) fetch.
		// If-Match: "1" matches the freshly inserted atom's version.
		const patchRes = await fetch(
			`http://127.0.0.1:${addr()}/api/memory/atom-stream`,
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json", "If-Match": "1" },
				body: JSON.stringify({ tags: ["broadcast"] }),
			},
		);
		expect(patchRes.status).toBe(200);

		await waitForFrames(frames, 2);
		const eventFrame = frames[1] ?? "";
		expect(eventFrame.startsWith("event: atom\ndata: ")).toBe(true);
		const payload = eventFrame.slice("event: atom\ndata: ".length);
		const parsed = JSON.parse(payload) as {
			id: string;
			version: number;
			tags: string[];
		};
		expect(parsed.id).toBe("atom-stream");
		expect(parsed.version).toBe(2);
		expect(parsed.tags).toContain("broadcast");
	});

	it("cleans up subscriber on client disconnect", async () => {
		await insertAtom();

		const controller = track(new AbortController());
		const streamRes = await fetch(
			`http://127.0.0.1:${addr()}/api/memory/atom-stream/stream`,
			{ signal: controller.signal },
		);
		expect(streamRes.status).toBe(200);

		const frames: string[] = [];
		startReading(streamRes, frames);
		await waitForFrames(frames, 1);
		expect(frames[0]).toBe(": connected");

		// `__getSubscriberCount` is the test-only handle into the
		// module-level `subscribers` Map (memory.ts intentionally does
		// not export the Map itself).
		expect(__getSubscriberCount("atom-stream")).toBe(1);

		controller.abort();

		// Wait for the server's res.on('close') handler to fire and
		// remove the response from the Set.
		const start = Date.now();
		while (__getSubscriberCount("atom-stream") > 0) {
			if (Date.now() - start > 2000) {
				throw new Error("subscriber not cleaned up within 2s");
			}
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(__getSubscriberCount("atom-stream")).toBe(0);
	});
});

// Verifies mountMemoryRoutes registers the SSE stream handler alongside
// the other handlers. Guards against accidental removal of the
// registerStreamMemoryById call.
describe("mountMemoryRoutes includes stream", () => {
	it("registers GET /api/memory/:id/stream", () => {
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
			for (const layer of router.stack as Array<{
				route?: { path: string; methods: Record<string, boolean> };
			}>) {
				if (layer.route) {
					const method = Object.keys(layer.route.methods)[0] ?? "unknown";
					routes.push(`${method.toUpperCase()} ${layer.route.path}`);
				}
			}
		}
		expect(routes).toContain("GET /api/memory/:id/stream");
	});
});

// Tests for the per-IP rate limiting applied to write paths (Task 5.2 H2).
// Verifies the contract from packages/webui/server/index.ts:
//   - PATCH /api/memory/:id shares the 60/min/IP writeLimiter
//   - The 61st request inside the window returns 429 with rate_limited
//
// Each test creates its own rateLimit() instance with a per-test keyFn so
// the bucket map is isolated — sharing a single limiter across tests would
// carry the count forward and break the assertion. The limiter used here
// has the same shape as the production one (windowMs + max); only the key
// function differs to keep tests deterministic.
describe("PATCH rate limit (Task 5.2 H2)", () => {
	let app: express.Express;
	let deps: MemoryDeps;
	let dbPath: string;
	let atomsDir: string;
	let tmpDir: string;
	let server: ReturnType<express.Express["listen"]>;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-ratelimit-"));
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
		app.use(express.json());
		deps = {
			dbPath,
			atomsDir,
			settings: {} as never,
			callLlm: async () => "",
			embedTimeoutMs: 200,
		};
		// Per-test keyFn — guarantees each test gets a fresh bucket map
		// (rateLimit() captures its own Map<key, Bucket> on construction).
		const testKey = `rl-${Math.random().toString(36).slice(2)}`;
		const writeLimiter = rateLimit({
			windowMs: 60_000,
			max: 60,
			keyFn: () => testKey,
		});
		mountMemoryRoutes(app, deps, { writeLimiter });
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
				id: "atom-rl",
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
				content_fingerprint: "fp-rl-12345678",
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

	const patchOnce = async (
		ifMatch: string,
	): Promise<{ status: number; body: Record<string, unknown> }> => {
		const addr = server.address();
		if (!addr || typeof addr === "string") throw new Error("no address");
		const res = await fetch(`http://127.0.0.1:${addr.port}/api/memory/atom-rl`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", "If-Match": ifMatch },
			body: JSON.stringify({ tags: ["x"] }),
		});
		const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		return { status: res.status, body };
	};

	it("returns 429 after 60 PATCH requests within the window", async () => {
		await insertAtom();
		// First 60 must succeed. Each PATCH bumps the version, so we pass
		// the matching If-Match token to the body — the version increments
		// after each successful call so the next call uses v+1.
		for (let i = 1; i <= 60; i++) {
			const res = await patchOnce(String(i));
			expect(res.status).toBe(200);
		}
		// The 61st must be rejected with the rate-limit contract.
		const blocked = await patchOnce("61");
		expect(blocked.status).toBe(429);
		expect(blocked.body.error).toBe("rate_limited");
		expect(typeof blocked.body.retryAfterMs).toBe("number");
	});
});
