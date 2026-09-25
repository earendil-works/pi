/**
 * Tests for plus/src/extensions/tasks/store.ts — file-backed task store:
 * create/update/delete transitions, dependency edges, id high-water mark,
 * and list filtering. Uses tmpdir stores; no real agent dir is touched.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { formatTaskLine, TaskStore } from "../../src/extensions/tasks/store.ts";

let dir: string;
let store: TaskStore;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plus-tasks-test-"));
	store = TaskStore.forDir(dir);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("create", () => {
	it("creates tasks with monotonically increasing ids", async () => {
		const a = await store.create({ subject: "A", description: "do A" });
		const b = await store.create({ subject: "B", description: "do B", activeForm: "doing B", owner: "scout" });
		assert.equal(a.id, "1");
		assert.equal(b.id, "2");
		assert.equal(a.status, "pending");
		assert.deepEqual(a.blocks, []);
		assert.equal(b.activeForm, "doing B");
		assert.equal(b.owner, "scout");
	});

	it("persists tasks to disk", async () => {
		const task = await store.create({ subject: "A", description: "do A" });
		const raw = JSON.parse(fs.readFileSync(path.join(dir, `${task.id}.json`), "utf-8"));
		assert.equal(raw.subject, "A");
	});
});

describe("update", () => {
	it("updates status and tracks updated fields", async () => {
		const task = await store.create({ subject: "A", description: "do A" });
		const result = await store.update(task.id, { status: "in_progress" });
		assert.ok(!("error" in result));
		assert.deepEqual(result.updatedFields, ["status"]);
		assert.equal(result.task.status, "in_progress");
	});

	it("returns an error for unknown ids", async () => {
		const result = await store.update("99", { status: "completed" });
		assert.ok("error" in result);
		assert.match(result.error, /not found/);
	});

	it("edits subject/description and adds dependency edges", async () => {
		const a = await store.create({ subject: "A", description: "do A" });
		const b = await store.create({ subject: "B", description: "do B" });
		const result = await store.update(a.id, { addBlocks: [b.id] });
		assert.ok(!("error" in result));
		assert.deepEqual(result.updatedFields, ["blocks"]);
		assert.deepEqual(result.task.blocks, [b.id]);

		const other = await store.update(b.id, { addBlockedBy: [a.id] });
		assert.ok(!("error" in other));
		assert.deepEqual(other.task.blockedBy, [a.id]);
	});

	it("does not duplicate dependency edges", async () => {
		const a = await store.create({ subject: "A", description: "do A" });
		const b = await store.create({ subject: "B", description: "do B" });
		await store.update(a.id, { addBlocks: [b.id] });
		const result = await store.update(a.id, { addBlocks: [b.id] });
		assert.ok(!("error" in result));
		assert.deepEqual(result.updatedFields, []);
	});

	it("status deleted removes the task file", async () => {
		const task = await store.create({ subject: "A", description: "do A" });
		const result = await store.update(task.id, { status: "deleted" });
		assert.ok(!("error" in result));
		assert.equal(result.task.status, "deleted");
		assert.equal(fs.existsSync(path.join(dir, `${task.id}.json`)), false);
	});
});

describe("high-water mark", () => {
	it("never reuses ids after delete", async () => {
		const a = await store.create({ subject: "A", description: "do A" });
		await store.update(a.id, { status: "deleted" });
		const b = await store.create({ subject: "B", description: "do B" });
		assert.equal(b.id, "2");
	});
});

describe("get / list", () => {
	it("gets a task by id and returns null for unknown ids", async () => {
		const task = await store.create({ subject: "A", description: "do A" });
		const fetched = await store.get(task.id);
		assert.equal(fetched?.subject, "A");
		assert.equal(await store.get("99"), null);
	});

	it("lists tasks sorted by id", async () => {
		await store.create({ subject: "C", description: "c" });
		await store.create({ subject: "A", description: "a" });
		await store.create({ subject: "B", description: "b" });
		const tasks = await store.list();
		assert.deepEqual(
			tasks.map((t) => t.subject),
			["C", "A", "B"],
		);
	});

	it("strips blockedBy entries pointing at completed tasks", async () => {
		const a = await store.create({ subject: "A", description: "a" });
		const b = await store.create({ subject: "B", description: "b" });
		await store.update(b.id, { addBlockedBy: [a.id] });
		await store.update(a.id, { status: "completed" });
		const tasks = await store.list();
		assert.deepEqual(tasks.find((t) => t.id === b.id)?.blockedBy, []);
	});

	it("hides tasks with metadata._internal", async () => {
		const task = await store.create({ subject: "A", description: "a" });
		// Simulate an internal task written behind the store's back.
		const raw = JSON.parse(fs.readFileSync(path.join(dir, `${task.id}.json`), "utf-8"));
		raw.metadata = { _internal: true };
		fs.writeFileSync(path.join(dir, `${task.id}.json`), JSON.stringify(raw));
		assert.deepEqual(await store.list(), []);
	});

	it("lists nothing for a missing directory", async () => {
		const empty = TaskStore.forDir(path.join(dir, "nope"));
		assert.deepEqual(await empty.list(), []);
	});
});

describe("formatTaskLine", () => {
	it("formats status, owner, and blockers", async () => {
		const a = await store.create({ subject: "Fix auth", description: "d" });
		const b = await store.create({ subject: "Write tests", description: "d" });
		await store.update(b.id, { status: "in_progress", owner: "worker", addBlockedBy: [a.id] });
		const tasks = await store.list();
		assert.equal(
			formatTaskLine(tasks.find((t) => t.id === b.id)!),
			`#${b.id} [in_progress] Write tests (worker) [blocked by #${a.id}]`,
		);
	});
});
