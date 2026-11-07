import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@earendil-works/pi-orchestra-core";
import { describe, expect, it } from "vitest";
import { GoalEngine } from "../src/goals.ts";

describe("goal engine", () => {
	it("failing check re-prompts; same-signature x3 escalates", () => {
		const dir = mkdtempSync(join(tmpdir(), "orch-goal-"));
		const store = new Store({ path: join(dir, "g.db") });
		try {
			const agent = store.createAgent({ name: "ada", role: "builder" });
			const task = store.createTask({ title: "t", spec: "s", ownerAgentId: agent.id });
			store.addCheck({ taskId: task.id, kind: "cmd", config: { command: "sh", argv: ["-c", "exit 1"] } });
			const goals = new GoalEngine(store);
			for (let i = 0; i < 3; i++) {
				const outcomes = goals.runChecks(task.id, dir);
				expect(outcomes[0]!.passed).toBe(false);
				goals.decide(task.id, outcomes);
			}
			expect(store.getTask(task.id)!.state).toBe("escalated");
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
