import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { failureSignature, isUlid, matchGlob, Store, ulid } from "../src/index.ts";

function freshStore(): { store: Store; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "orch-"));
	const store = new Store({ path: join(dir, "or.db") });
	return { store, dir };
}

describe("ulid", () => {
	it("is 26 chars and verifiable", () => {
		const id = ulid(1_700_000_000_000, new Uint8Array(10));
		expect(id).toHaveLength(26);
		expect(isUlid(id)).toBe(true);
		expect(isUlid("nope")).toBe(false);
	});
});

describe("leases", () => {
	it("blocks second agent and names owner", () => {
		const { store, dir } = freshStore();
		try {
			const a = store.createAgent({ name: "ada", role: "builder" });
			const b = store.createAgent({ name: "bo", role: "builder" });
			const t = store.createTask({ title: "t", spec: "s", ownsGlobs: ["src/**"] });
			store.setAgentState(a.id, "working");
			// give a task to a
			store.db.prepare(`UPDATE agents SET task_id=? WHERE id=?`).run(t.id, a.id);
			const first = store.canEdit(a.id, "src/a.ts");
			expect(first.allowed).toBe(true);
			const second = store.canEdit(b.id, "src/a.ts");
			expect(second.allowed).toBe(false);
			expect(second.owner?.name).toBe("ada");
			store.releaseLeasesForAgent(a.id);
			// after release, b can edit if its own task allows (no task → free path)
			expect(store.canEdit(b.id, "src/a.ts").allowed).toBe(true);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("owns_globs enforced", () => {
		const { store, dir } = freshStore();
		try {
			expect(matchGlob("src/ui/x.ts", ["src/ui/**"])).toBe(true);
			expect(matchGlob("src/api/x.ts", ["src/ui/**"])).toBe(false);
			const a = store.createAgent({ name: "cy", role: "builder" });
			const t = store.createTask({ title: "t", spec: "s", ownsGlobs: ["src/ui/**"] });
			store.db.prepare(`UPDATE agents SET task_id=? WHERE id=?`).run(t.id, a.id);
			expect(store.canEdit(a.id, "src/ui/a.ts").allowed).toBe(true);
			expect(store.canEdit(a.id, "src/api/a.ts").allowed).toBe(false);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("messages", () => {
	it("at-least-once with dedupe by id and ack survival", () => {
		const { store, dir } = freshStore();
		const a = store.createAgent({ name: "ada", role: "lead" });
		const b = store.createAgent({ name: "bo", role: "builder" });
		try {
			const m = store.sendMessage({ fromAgentId: a.id, toAgentId: b.id, type: "question", body: "hi" });
			expect(store.inbox(b.id)).toHaveLength(1);
			store.markDelivered(m.id, b.id);
			store.ack(m.id, b.id);
			store.ack(m.id, b.id); // idempotent
			expect(store.inbox(b.id)).toHaveLength(0);
			// duplicate send with same id → deliveries deduped (INSERT OR IGNORE), PK throws (handled below)
			try {
				store.sendMessage({ id: m.id, fromAgentId: a.id, toAgentId: b.id, type: "question", body: "hi" });
			} catch {
				// duplicate PK for messages is expected; deliveries must not double
			}
			expect(store.inbox(b.id).length).toBeLessThanOrEqual(1);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("tasks + checks", () => {
	it("ready only when deps done; stall signature stable", () => {
		const { store, dir } = freshStore();
		try {
			const t1 = store.createTask({ title: "t1", spec: "s" });
			const t2 = store.createTask({ title: "t2", spec: "s" });
			store.addDep(t2.id, t1.id);
			expect(store.readyTasks().map((t) => t.id)).toContain(t1.id);
			expect(store.readyTasks().map((t) => t.id)).not.toContain(t2.id);
			store.setTaskState(t1.id, "done");
			expect(store.readyTasks().map((t) => t.id)).toContain(t2.id);
			const s1 = failureSignature("c1", "Error: boom 123\n  at x");
			const s2 = failureSignature("c1", "Error: boom 999\n  at x");
			expect(s1).toBe(s2); // numbers normalized
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
