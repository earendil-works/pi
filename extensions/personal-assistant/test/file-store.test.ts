import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	computeContentHash,
	normalizeMarkdown,
	readAtomFromFile,
	writeAtomToFile,
} from "../file-store.ts";
import type { MemoryAtom } from "../types.ts";

// File-store — atom-on-disk with id-based paths (no slug collision).
//
// Architecture constraints (from design.md Decisions 3, 4):
//   - File path = <baseDir>/<type>/<atom.id>.md (NEVER title slug)
//   - readAtomFromFile returns null on missing/malformed/stale — never throws
//   - Frontmatter is simple key:value (no nested structures beyond tags array)
//   - content_fingerprint is recomputed from body, not trusted from frontmatter
describe("file-store", () => {
	let tmpDir: string;
	let baseDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "atom-test-"));
		baseDir = path.join(tmpDir, "atoms");
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	const sampleAtom = (overrides: Partial<MemoryAtom> = {}): MemoryAtom => ({
		id: "test-atom-1",
		type: "rule",
		title: "测试 atom",
		content: "这是一个测试 content。\n多行。",
		summary: "summary",
		tags: ["test", "中文"],
		importance: 0.7,
		strength: 0.7,
		access_count: 0,
		version: 1,
		is_latest: 1,
		parent_id: null,
		superseded_at: null,
		archived: 0,
		created_at: 1700000000000,
		updated_at: 1700000000000,
		last_access: null,
		content_fingerprint: "abc123def456",
		source_session: null,
		...overrides,
	});

	it("writeAtomToFile writes to <baseDir>/<type>/<id>.md", async () => {
		const atom = sampleAtom({ id: "atom-001", type: "fact" });
		const fp = await writeAtomToFile(atom, baseDir);
		expect(fp).toBe(path.join(baseDir, "fact", "atom-001.md"));
		const exists = await fs.stat(fp).then(() => true).catch(() => false);
		expect(exists).toBe(true);
	});

	it("writeAtomToFile creates nested directory recursively", async () => {
		const atom = sampleAtom({ type: "process" });
		await writeAtomToFile(atom, baseDir);
		const exists = await fs
			.stat(path.join(baseDir, "process"))
			.then(() => true)
			.catch(() => false);
		expect(exists).toBe(true);
	});

	it("readAtomFromFile round-trips atom", async () => {
		const atom = sampleAtom();
		await writeAtomToFile(atom, baseDir);
		const result = await readAtomFromFile(path.join(baseDir, "rule", `${atom.id}.md`));
		expect(result).not.toBeNull();
		expect(result?.atom.title).toBe(atom.title);
		expect(result?.atom.tags).toEqual(atom.tags);
		expect(result?.atom.content).toBe(atom.content);
	});

	it("readAtomFromFile returns null if file missing", async () => {
		const result = await readAtomFromFile(path.join(baseDir, "rule", "missing.md"));
		expect(result).toBeNull();
	});

	it("readAtomFromFile returns null if hash mismatch (stale)", async () => {
		const atom = sampleAtom();
		await writeAtomToFile(atom, baseDir);
		const result = await readAtomFromFile(
			path.join(baseDir, "rule", `${atom.id}.md`),
			"wrong-hash",
		);
		expect(result).toBeNull();
	});

	it("readAtomFromFile returns null if frontmatter malformed", async () => {
		const dir = path.join(baseDir, "rule");
		await fs.mkdir(dir, { recursive: true });
		const fp = path.join(dir, "bad.md");
		await fs.writeFile(fp, "no frontmatter here", "utf8");
		const result = await readAtomFromFile(fp);
		expect(result).toBeNull();
	});

	it("normalizeMarkdown splits frontmatter from body", () => {
		const raw = "---\nkey: value\n---\nbody content\n";
		const result = normalizeMarkdown(raw);
		expect(result?.frontmatter).toBe("key: value");
		expect(result?.body).toBe("body content\n");
	});

	it("normalizeMarkdown returns null if no frontmatter", () => {
		expect(normalizeMarkdown("just body")).toBeNull();
	});

	it("computeContentHash is deterministic and 16 chars", () => {
		const h1 = computeContentHash("hello");
		const h2 = computeContentHash("hello");
		expect(h1).toBe(h2);
		expect(h1).toHaveLength(16);
	});

	// ---- Edge cases beyond the spec, exercising constraints & scenarios ----

	it("writeAtomToFile rejects atom.id with path separators (path traversal)", async () => {
		const atom = sampleAtom({ id: "../escape" });
		await expect(writeAtomToFile(atom, baseDir)).rejects.toThrow(/unsafe atom id/);
	});

	it("writeAtomToFile rejects atom.id with forward slash", async () => {
		const atom = sampleAtom({ id: "sub/dir" });
		await expect(writeAtomToFile(atom, baseDir)).rejects.toThrow(/unsafe atom id/);
	});

	it("writeAtomToFile rejects empty atom.id", async () => {
		const atom = sampleAtom({ id: "" });
		await expect(writeAtomToFile(atom, baseDir)).rejects.toThrow(/unsafe atom id/);
	});

	it("writeAtomToFile accepts UUID-format id", async () => {
		const uuid = "550e8400-e29b-41d4-a716-446655440000";
		const atom = sampleAtom({ id: uuid });
		const fp = await writeAtomToFile(atom, baseDir);
		expect(fp).toBe(path.join(baseDir, "rule", `${uuid}.md`));
	});

	it("round-trip preserves null nullable fields", async () => {
		const atom = sampleAtom({
			parent_id: null,
			superseded_at: null,
			last_access: null,
			source_session: null,
		});
		await writeAtomToFile(atom, baseDir);
		const result = await readAtomFromFile(path.join(baseDir, "rule", `${atom.id}.md`));
		expect(result?.atom.parent_id).toBeNull();
		expect(result?.atom.superseded_at).toBeNull();
		expect(result?.atom.last_access).toBeNull();
		expect(result?.atom.source_session).toBeNull();
	});

	it("round-trip preserves populated nullable fields", async () => {
		const atom = sampleAtom({
			parent_id: "parent-uuid-001",
			superseded_at: 1700000000001,
			last_access: 1700000000002,
			source_session: "session-xyz",
		});
		await writeAtomToFile(atom, baseDir);
		const result = await readAtomFromFile(path.join(baseDir, "rule", `${atom.id}.md`));
		expect(result?.atom.parent_id).toBe("parent-uuid-001");
		expect(result?.atom.superseded_at).toBe(1700000000001);
		expect(result?.atom.last_access).toBe(1700000000002);
		expect(result?.atom.source_session).toBe("session-xyz");
	});

	it("round-trip preserves numeric fields (float + int + 0|1)", async () => {
		const atom = sampleAtom({
			importance: 0.123,
			strength: 0.456,
			access_count: 42,
			version: 3,
			is_latest: 1,
			archived: 0,
		});
		await writeAtomToFile(atom, baseDir);
		const result = await readAtomFromFile(path.join(baseDir, "rule", `${atom.id}.md`));
		expect(result?.atom.importance).toBe(0.123);
		expect(result?.atom.strength).toBe(0.456);
		expect(result?.atom.access_count).toBe(42);
		expect(result?.atom.version).toBe(3);
		expect(result?.atom.is_latest).toBe(1);
		expect(result?.atom.archived).toBe(0);
	});

	it("round-trip preserves multi-line content (newlines intact)", async () => {
		const multi = "line 1\nline 2\nline 3\n\nline 5";
		const atom = sampleAtom({ content: multi });
		await writeAtomToFile(atom, baseDir);
		const result = await readAtomFromFile(path.join(baseDir, "rule", `${atom.id}.md`));
		expect(result?.atom.content).toBe(multi);
	});

	it("round-trip preserves content with quotes, backslashes, and dashes", async () => {
		const tricky = `She said "hi"\npath: C:\\foo\\bar\n---\nnot-a-marker`;
		const atom = sampleAtom({ content: tricky });
		await writeAtomToFile(atom, baseDir);
		const result = await readAtomFromFile(path.join(baseDir, "rule", `${atom.id}.md`));
		expect(result?.atom.content).toBe(tricky);
	});

	it("contentHash matches computeContentHash on body", async () => {
		const atom = sampleAtom({ content: "hash me" });
		await writeAtomToFile(atom, baseDir);
		const result = await readAtomFromFile(path.join(baseDir, "rule", `${atom.id}.md`));
		expect(result?.contentHash).toBe(computeContentHash(result?.atom.content ?? ""));
	});

	it("readAtomFromFile with matching hash succeeds", async () => {
		const atom = sampleAtom({ content: "verify hash" });
		await writeAtomToFile(atom, baseDir);
		const fp = path.join(baseDir, "rule", `${atom.id}.md`);
		// First read: discover the hash.
		const first = await readAtomFromFile(fp);
		expect(first).not.toBeNull();
		// Second read: validate against the discovered hash.
		const second = await readAtomFromFile(fp, first?.contentHash);
		expect(second).not.toBeNull();
		expect(second?.atom.title).toBe(atom.title);
	});

	// ---- Escape/unescape ambiguity (regression) ----
	//
	// Earlier serialize/parse used a multi-pass replace that could not
	// distinguish a literal `\` followed by `n` from a `\n` escape sequence.
	// The fix uses a single-pass `\\(.)` regex on parse (with serialize matching
	// it). These tests guard the round-trip for the bug-reported inputs.

	it("preserves literal backslash + n in title round-trip", async () => {
		// Literal 6-char string: t e s t \ n
		const atom = sampleAtom({ title: "test\\n" });
		await writeAtomToFile(atom, baseDir);
		const result = await readAtomFromFile(path.join(baseDir, "rule", `${atom.id}.md`));
		expect(result).not.toBeNull();
		expect(result?.atom.title).toBe("test\\n");
	});

	it("preserves literal backslash + backslash in summary", async () => {
		// Literal Windows-style path: p a t h \ t o \ f i l e
		const atom = sampleAtom({ summary: "path\\to\\file" });
		await writeAtomToFile(atom, baseDir);
		const result = await readAtomFromFile(path.join(baseDir, "rule", `${atom.id}.md`));
		expect(result?.atom.summary).toBe("path\\to\\file");
	});

	it("preserves mixed newlines and backslashes", async () => {
		const atom = sampleAtom({
			title: "Line 1\\nLine 2", // literal \n (not a newline)
			summary: "Has\\nmultiple\\nliteral sequences",
		});
		await writeAtomToFile(atom, baseDir);
		const result = await readAtomFromFile(path.join(baseDir, "rule", `${atom.id}.md`));
		expect(result?.atom.title).toBe("Line 1\\nLine 2");
		expect(result?.atom.summary).toBe("Has\\nmultiple\\nliteral sequences");
	});

	it("preserves actual newlines in title alongside literal backslash-n", async () => {
		// Title mixes a real newline with a literal `\n` sequence.
		const atom = sampleAtom({ title: "Line 1\nLine 2\\nLine 3" });
		await writeAtomToFile(atom, baseDir);
		const result = await readAtomFromFile(path.join(baseDir, "rule", `${atom.id}.md`));
		expect(result?.atom.title).toBe("Line 1\nLine 2\\nLine 3");
	});

	it("preserves escaped double quote inside a quoted field", async () => {
		const atom = sampleAtom({ title: 'She said "hi"' });
		await writeAtomToFile(atom, baseDir);
		const result = await readAtomFromFile(path.join(baseDir, "rule", `${atom.id}.md`));
		expect(result?.atom.title).toBe('She said "hi"');
	});
});