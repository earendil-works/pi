import { mkdtemp, readFile, stat, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { beforeEach, describe, expect, it } from "vitest";
import { coerceTodoFrontmatter, parseTodoMarkdownOrThrow } from "../src/todos/todo-file.js";
import { TodoStore, type WhoAmI } from "../src/todos/todo-store.js";

const WHO: WhoAmI = { sessionId: "session-1", runId: "run-1" };
const OTHER: WhoAmI = { sessionId: "session-2", runId: "run-2" };

async function makeStore(baseNowMs: number = Date.parse("2026-02-08T02:00:00.000Z")) {
	const dir = await mkdtemp(join(tmpdir(), "mu-todos-test-"));
	let nowMs = baseNowMs;
	const store = new TodoStore({
		rootDir: dir,
		lockTtlMs: 1000,
		now: () => {
			const v = nowMs;
			nowMs += 1;
			return v;
		},
	});
	await store.ensureDir();
	return { dir, store };
}

describe("TodoStore", () => {
	let store: TodoStore;
	let dir: string;

	beforeEach(async () => {
		({ dir, store } = await makeStore());
	});

	it("create writes a file with default list=inbox and status=open", async () => {
		const created = await store.create({ title: "Hello", who: WHO });
		expect(created.frontmatter.list).toBe("inbox");
		expect(created.frontmatter.status).toBe("open");
		expect(created.frontmatter.created_at).toBe("2026-02-08T02:00:00.000Z");
		expect(created.frontmatter.updated_at).toBe("2026-02-08T02:00:00.000Z");

		const fileText = await readFile(created.path, "utf8");
		const parsed = parseTodoMarkdownOrThrow(fileText);
		const fm = coerceTodoFrontmatter(parsed.frontmatter);
		expect(fm.title).toBe("Hello");
	});

	it("create can claim on create", async () => {
		const created = await store.create({ title: "Claim me", claim: true, who: WHO });
		expect(created.frontmatter.assigned_to_session).toBe("session-1");
		expect(created.frontmatter.assigned_to_run).toBe("run-1");
	});

	it("get returns null when missing", async () => {
		expect(await store.get("missing")).toBeNull();
	});

	it("update changes fields/body and bumps updated_at", async () => {
		const created = await store.create({ title: "A", body: "Body", who: WHO });
		const later = new TodoStore({ rootDir: dir, lockTtlMs: 1000, now: () => Date.parse("2026-02-08T03:00:00.000Z") });
		const updated = await later.update(created.frontmatter.id, { title: "B", body: "New", who: WHO });
		expect(updated.frontmatter.title).toBe("B");
		expect(updated.body).toContain("New");
		expect(updated.frontmatter.updated_at).toBe("2026-02-08T03:00:00.000Z");
	});

	it("append adds markdown without clobbering", async () => {
		const created = await store.create({ title: "A", body: "First", who: WHO });
		const updated = await store.append(created.frontmatter.id, { markdown: "Second", who: WHO });
		expect(updated.body).toContain("First");
		expect(updated.body).toContain("Second");
	});

	it("claim fails if assigned to other session/run unless force", async () => {
		const created = await store.create({ title: "A", claim: true, who: OTHER });
		await expect(store.claim(created.frontmatter.id, { who: WHO })).rejects.toThrow("assigned");

		const forced = await store.claim(created.frontmatter.id, { who: WHO, force: true });
		expect(forced.frontmatter.assigned_to_session).toBe("session-1");
	});

	it("release fails if assigned to other session/run unless force", async () => {
		const created = await store.create({ title: "A", claim: true, who: OTHER });
		await expect(store.release(created.frontmatter.id, { who: WHO })).rejects.toThrow("assigned");

		const forced = await store.release(created.frontmatter.id, { who: WHO, force: true });
		expect(forced.frontmatter.assigned_to_session).toBeUndefined();
	});

	it("done/cancelled auto-clears assignment", async () => {
		const created = await store.create({ title: "A", claim: true, who: WHO });
		const updated = await store.update(created.frontmatter.id, { status: "done", who: WHO });
		expect(updated.frontmatter.assigned_to_session).toBeUndefined();
		expect(updated.frontmatter.assigned_to_run).toBeUndefined();
	});

	it("list filters by list/status/tags and sorts stable", async () => {
		const t1 = await store.create({ title: "T1", list: "alpha", tags: ["x"], who: WHO });
		const t2 = await store.create({ title: "T2", list: "alpha", tags: ["x", "y"], who: WHO });
		await store.update(t2.frontmatter.id, { status: "in_progress", who: WHO });
		await store.update(t1.frontmatter.id, { status: "done", who: WHO });

		const activeAlpha = await store.list({ list: "alpha" }, WHO);
		// done is hidden by default
		expect(activeAlpha.map((t) => t.frontmatter.title)).toEqual(["T2"]);

		const includeClosed = await store.list({ list: "alpha", includeClosed: true }, WHO);
		expect(includeClosed.map((t) => t.frontmatter.title)).toEqual(["T2", "T1"]);

		const tagFilter = await store.list({ tags: ["y"], includeClosed: true }, WHO);
		expect(tagFilter.map((t) => t.frontmatter.title)).toEqual(["T2"]);

		await store.claim(t2.frontmatter.id, { who: WHO });
		const mine = await store.list({ assignment: "mine", includeClosed: true }, WHO);
		expect(mine.map((t) => t.frontmatter.title)).toEqual(["T2"]);

		const unassigned = await store.list({ assignment: "unassigned", includeClosed: true }, WHO);
		expect(unassigned.map((t) => t.frontmatter.title)).toEqual(["T1"]);
	});

	it("claimNext claims the first unassigned open todo", async () => {
		const a = await store.create({ title: "A", who: WHO });
		const b = await store.create({ title: "B", who: WHO });
		await store.claim(a.frontmatter.id, { who: OTHER, force: true });

		const claimed = await store.claimNext({}, WHO);
		expect(claimed?.frontmatter.id).toBe(b.frontmatter.id);
		expect(claimed?.frontmatter.assigned_to_session).toBe("session-1");
	});

	it("delete requires force if assigned", async () => {
		const created = await store.create({ title: "A", claim: true, who: WHO });
		await expect(store.delete(created.frontmatter.id, WHO, false)).rejects.toThrow("force");
		await expect(store.delete(created.frontmatter.id, WHO, true)).resolves.toBeUndefined();
		expect(await store.get(created.frontmatter.id)).toBeNull();
	});

	it("stale lock can be stolen only with force", async () => {
		const created = await store.create({ title: "A", who: WHO });
		const lockPath = join(dir, `${created.frontmatter.id}.lock`);
		// Simulate an external lock file.
		await writeFile(lockPath, "locked\n", "utf8");
		expect((await stat(lockPath)).isFile()).toBe(true);

		// Make it stale (mtime 2s ago, ttl is 1s)
		const old = new Date(Date.parse("2026-02-08T01:59:58.000Z"));
		await utimes(lockPath, old, old);

		await expect(store.update(created.frontmatter.id, { title: "B", who: WHO, force: false })).rejects.toThrow(
			"locked",
		);
		await expect(store.update(created.frontmatter.id, { title: "B", who: WHO, force: true })).resolves.toBeTruthy();
	});
});
