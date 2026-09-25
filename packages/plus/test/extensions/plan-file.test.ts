/**
 * Tests for plus/src/extensions/plan/plan-file.ts — plan file path resolution
 * under <agentDir>/plans and the plan-file carve-out check used by the gate.
 * Uses a tmp agent dir via the PI_CODING_AGENT_DIR env knob; no real agent
 * dir is touched.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
	isPlanFileTarget,
	planFilePathFor,
	plansDir,
	readPlan,
	writePlan,
} from "../../src/extensions/plan/plan-file.ts";

let agentDir: string;
let previousEnv: string | undefined;

beforeEach(() => {
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plus-plan-test-"));
	previousEnv = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (previousEnv === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = previousEnv;
	}
	fs.rmSync(agentDir, { recursive: true, force: true });
});

describe("plan file paths", () => {
	it("resolves plans under the agent dir and sanitizes session ids", () => {
		const planPath = planFilePathFor("sess/ion:1");
		assert.equal(planPath, path.join(agentDir, "plans", "sess_ion_1.md"));
		assert.equal(path.dirname(planPath), plansDir());
		assert.ok(fs.existsSync(plansDir()), "plans dir created lazily");
	});

	it("round-trips plan content through write/read", async () => {
		const planPath = planFilePathFor("s1");
		assert.equal(await readPlan(planPath), "", "missing plan reads as empty");
		await writePlan(planPath, "# Plan\n\ndo things\n");
		assert.equal(await readPlan(planPath), "# Plan\n\ndo things\n");
	});
});

describe("isPlanFileTarget", () => {
	it("matches the plan path as absolute, relative-to-cwd, and via ../..", () => {
		const planPath = path.join(agentDir, "plans", "s1.md");
		const cwd = path.join(agentDir, "plans", "deep", "dir");
		fs.mkdirSync(cwd, { recursive: true });
		assert.ok(isPlanFileTarget(cwd, planPath, planPath));
		assert.ok(isPlanFileTarget(planPath, planPath, planPath));
		assert.ok(isPlanFileTarget(cwd, "../../s1.md", planPath));
	});

	it("rejects other files, including siblings in the plans dir", () => {
		const planPath = path.join(agentDir, "plans", "s1.md");
		const cwd = agentDir;
		assert.ok(!isPlanFileTarget(cwd, path.join(agentDir, "plans", "s2.md"), planPath));
		assert.ok(!isPlanFileTarget(cwd, path.join(agentDir, "other.md"), planPath));
		assert.ok(!isPlanFileTarget(cwd, "src/index.ts", planPath));
	});

	it("rejects empty and non-string paths", () => {
		const planPath = path.join(agentDir, "plans", "s1.md");
		assert.ok(!isPlanFileTarget(agentDir, "", planPath));
		assert.ok(!isPlanFileTarget(agentDir, undefined, planPath));
		assert.ok(!isPlanFileTarget(agentDir, 42, planPath));
	});

	it("matches through a symlinked agent dir", () => {
		if (process.platform === "win32") return;
		const linkDir = `${agentDir}-link`;
		try {
			fs.symlinkSync(agentDir, linkDir, "dir");
			const planPath = path.join(agentDir, "plans", "s1.md");
			// Address the plan file through the symlink; parent-dir realpathing must reconcile it.
			assert.ok(isPlanFileTarget(linkDir, path.join(linkDir, "plans", "s1.md"), planPath));
		} finally {
			fs.rmSync(linkDir, { recursive: true, force: true });
		}
	});
});
