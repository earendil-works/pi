import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { updatePlanTool } from "./update-plan.js";

describe("update_plan tool", () => {
	let tempDir: string | null = null;
	let originalCwd: string | null = null;
	let originalEnv: Partial<NodeJS.ProcessEnv> | null = null;

	afterEach(async () => {
		if (originalEnv) {
			for (const [k, v] of Object.entries(originalEnv)) {
				if (v === undefined) {
					delete process.env[k];
				} else {
					process.env[k] = v;
				}
			}
			originalEnv = null;
		}
		if (originalCwd) {
			process.chdir(originalCwd);
			originalCwd = null;
		}
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
			tempDir = null;
		}
	});

	it("writes the plan to a durable file", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mu-update-plan-"));
		originalCwd = process.cwd();
		process.chdir(tempDir);

		originalEnv = {
			MU_SESSION_ID: process.env.MU_SESSION_ID,
			MU_RUN_ID: process.env.MU_RUN_ID,
			MU_PLAN_PATH: process.env.MU_PLAN_PATH,
		};
		process.env.MU_SESSION_ID = "test_session";
		process.env.MU_RUN_ID = "test_run";
		delete process.env.MU_PLAN_PATH;

		const result = await updatePlanTool.execute("toolcall_1", {
			explanation: "Testing",
			plan: [
				{ step: "First step", status: "in_progress" },
				{ step: "Second step", status: "pending" },
			],
		});

		expect(result.details.path).toContain(join(tempDir, ".mu", "plans", "test_session.json"));

		const raw = await readFile(result.details.path, "utf8");
		const parsed = JSON.parse(raw) as { explanation?: string; plan?: unknown };
		expect(parsed.explanation).toBe("Testing");
		expect(Array.isArray(parsed.plan)).toBe(true);
	});

	it("returns mu_display metadata for concise TUI rendering", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mu-update-plan-"));
		originalCwd = process.cwd();
		process.chdir(tempDir);

		originalEnv = {
			MU_SESSION_ID: process.env.MU_SESSION_ID,
			MU_RUN_ID: process.env.MU_RUN_ID,
			MU_PLAN_PATH: process.env.MU_PLAN_PATH,
		};
		process.env.MU_SESSION_ID = "test_session";
		process.env.MU_RUN_ID = "test_run";
		delete process.env.MU_PLAN_PATH;

		const result = await updatePlanTool.execute("toolcall_1", {
			explanation: "Testing",
			plan: [
				{ step: "First step", status: "in_progress" },
				{ step: "Second step", status: "pending" },
			],
		});

		const details = result.details as
			| {
					mu_display?: {
						version?: number;
						call?: { text?: string };
						summary?: { text?: string };
						output?: { collapse?: { maxVisualLines?: number } };
					};
			  }
			| undefined;

		expect(details?.mu_display?.version).toBe(1);
		expect(details?.mu_display?.call?.text).toContain("update_plan");
		expect(details?.mu_display?.summary?.text).toContain("1 in_progress");
		expect(details?.mu_display?.summary?.text).toContain("1 pending");
		expect(details?.mu_display?.output?.collapse?.maxVisualLines).toBe(8);
	});
});
