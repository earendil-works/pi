import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@earendil-works/pi-orchestra-core";
import { describe, expect, it } from "vitest";
import { detectComms } from "../src/comms.ts";
import { buildITerm2Script, perTabCount } from "../src/layout.ts";
import { composeAgentPrompt, planRun } from "../src/planner.ts";
import { createSupervisor } from "../src/supervisor.ts";
import { assignThinking } from "../src/thinking.ts";
import { completionGate, evidenceAudit, targetedReprompt } from "../src/watchdog.ts";

function freshStore(): { store: Store; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "orch-prod-"));
	return { store: new Store({ path: join(dir, "p.db") }), dir };
}

describe("planner + prompts", () => {
	it("writes strict versioned prompts with goal verbatim and checks", () => {
		const { store, dir } = freshStore();
		try {
			const out = planRun(store, {
				goal: "Build /items page",
				intent: "fast, simple",
				agentCount: 2,
				thinkingMode: "dynamic",
				tasks: [
					{
						title: "api",
						spec: "Build /items endpoint, returns price in cents",
						ownsGlobs: ["src/api/**"],
						checks: [{ kind: "cmd", config: { command: "sh", argv: ["-c", "true"] } }],
						thinking: "medium",
						reasoning: "",
					},
				],
			});
			expect(out.agentIds).toHaveLength(1); // min(tasks, agents) → never idle
			const prompts = store.listPrompts(out.agentIds[0]!);
			expect(prompts).toHaveLength(1);
			expect(prompts[0]!.text).toContain("Build /items page");
			expect(prompts[0]!.text).toContain("checks pass, not claims");
			expect(prompts[0]!.text).toContain("src/api/**");
			expect(prompts[0]!.version).toBe(1);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("composeAgentPrompt order: goal, task, teammates, workflow", () => {
		const p = composeAgentPrompt({
			goal: "G",
			agentName: "ada",
			taskTitle: "T",
			taskSpec: "S",
			ownsGlobs: [],
			checks: [],
			teammates: [{ name: "bo", owns: ["src/"] }],
			thinkingLevel: "high",
		});
		const gi = p.indexOf("G");
		const ti = p.indexOf("T");
		const wi = p.indexOf("Required workflow");
		expect(gi).toBeLessThan(ti);
		expect(ti).toBeLessThan(wi);
	});
});

describe("watchdog evidence audit", () => {
	it("finds no-test-after-edit and targeted reprompt (no generic do better)", () => {
		const gaps = evidenceAudit({
			taskId: "t",
			worktree: "/tmp",
			ownsGlobs: ["src/**"],
			changedFiles: ["src/a.ts"],
			lastEditAt: Date.now(),
			hasTestAfterEdit: false,
			hasTypecheckAfterEdit: true,
			isUI: false,
			diffText: "ok",
		});
		expect(gaps.map((g) => g.type)).toContain("no-test-after-edit");
		const rep = targetedReprompt(gaps);
		expect(rep).toContain("no test command ran");
		expect(rep).not.toContain("do better");
	});
	it("completionGate fails without evidence even if checks pass", async () => {
		const { store, dir } = freshStore();
		try {
			const r = await completionGate({
				store,
				taskId: "t",
				worktree: "/tmp",
				spec: "s",
				checks: [{ checkId: "c", passed: true, signature: "s", output: "ok" }],
				audit: {
					taskId: "t",
					worktree: "/tmp",
					ownsGlobs: [],
					changedFiles: [],
					lastEditAt: 0,
					hasTestAfterEdit: false,
					hasTypecheckAfterEdit: true,
					isUI: false,
					diffText: "",
				},
			});
			expect(r.complete).toBe(false);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("thinking", () => {
	it("assigns different levels for trivial vs hard", () => {
		const trivial = assignThinking({ spec: "fix typo in readme", ownsGlobs: ["README.md"], checks: [] });
		const hard = assignThinking({
			spec: "migrate auth race condition, crypto token",
			ownsGlobs: ["src/a/**", "src/b/**", "src/c/**"],
			checks: [{ kind: "cmd" }, { kind: "cmd" }],
		});
		expect(trivial.level).toBe("low");
		expect(hard.level).toBe("xhigh");
		expect(trivial.level).not.toBe(hard.level);
	});
});

describe("layout", () => {
	it("uses cells: 200x55 gives 4, 250x70 gives 7-8, tiny gives 2", () => {
		expect(perTabCount({ cols: 200, rows: 55, agentCount: 6 }).perTab).toBe(4);
		const p = perTabCount({ cols: 250, rows: 70, agentCount: 10 });
		expect([7, 8]).toContain(p.perTab);
		expect(perTabCount({ cols: 40, rows: 10, agentCount: 6 }).perTab).toBe(2);
		const script = buildITerm2Script(["supervisor", "a", "b", "c"], { cols: 200, rows: 55 });
		expect(script).toContain("split vertically");
		expect(script).toContain("split horizontally");
	});
});

describe("comms watch", () => {
	it("detects unanswered question past timeout", () => {
		const { store, dir } = freshStore();
		try {
			const a = store.createAgent({ name: "ada", role: "lead" });
			const b = store.createAgent({ name: "bo", role: "builder" });
			const m = store.sendMessage({ fromAgentId: a.id, toAgentId: b.id, type: "question", body: "q?" });
			// Backdate the message past timeout.
			store.db.prepare(`UPDATE messages SET created_at=? WHERE id=?`).run(Date.now() - 120_000, m.id);
			const issues = detectComms(store, { questionTimeoutMs: 60_000 });
			expect(issues.some((i) => i.type === "unanswered-question")).toBe(true);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("security: per-agent bearer tokens", () => {
	it("missing, wrong and cross-agent tokens rejected; correct token works", async () => {
		const dir = mkdtempSync(join(tmpdir(), "orch-sec-"));
		const sup = createSupervisor({ config: { dbPath: join(dir, "s.db"), port: 0 } });
		await sup.listen();
		try {
			const a = sup.spawnAgent({ name: "ada", role: "builder", taskSpec: "t" });
			const b = sup.spawnAgent({ name: "bo", role: "builder", taskSpec: "t" });
			if (!("agent" in a) || !("agent" in b)) throw new Error("spawn failed");
			const base = sup.supervisorUrl;
			const post = async (path: string, body: unknown, token?: string) =>
				fetch(`${base}${path}`, {
					method: "POST",
					headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
					body: JSON.stringify(body),
				});
			// Missing
			expect((await post("/can-edit", { agentId: a.agent.id, filePath: "src/x.ts" })).status).toBe(401);
			// Wrong
			expect((await post("/can-edit", { agentId: a.agent.id, filePath: "src/x.ts" }, "wrong")).status).toBe(401);
			// Cross-agent: B token claiming A id
			expect((await post("/can-edit", { agentId: a.agent.id, filePath: "src/x.ts" }, b.agent.token)).status).toBe(
				401,
			);
			// Correct
			expect((await post("/can-edit", { agentId: a.agent.id, filePath: "src/x.ts" }, a.agent.token)).status).toBe(
				200,
			);
			// Health unauthenticated
			expect((await fetch(`${base}/health`)).status).toBe(200);
		} finally {
			await sup.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
