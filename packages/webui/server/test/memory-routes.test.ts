// Tests for the GET /api/memory/:id route. Covers S21 (full atom + content),
// S22 (404 for missing atom), and S23 (content="" on missing/stale .md file).
//
// The route imports from extensions/personal-assistant via relative paths
// because that extension is not a workspace package and its index.ts only
// re-exports runMemoryExtraction. Relative paths work for both vitest and
// the esbuild server bundle.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { registerGetMemoryById, type MemoryDeps } from "../routes/memory.ts";

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
