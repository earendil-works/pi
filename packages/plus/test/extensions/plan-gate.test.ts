/**
 * Tests for plus/src/extensions/plan/gate.ts — the read-only tool gate active
 * while plan mode is on: bash allowlist, edit/write plan-file carve-out,
 * subagent restriction, unknown custom tool blocking, and the no-op path when
 * plan mode is off.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { ToolCallEvent } from "../../../coding-agent/src/core/extensions/types.ts";
import { gateToolCall, isSafeCommand } from "../../src/extensions/plan/gate.ts";
import { createPlanState, type PlanModeState } from "../../src/extensions/plan/state.ts";

const CWD = "/home/user/project";
const PLAN_PATH = "/home/user/.pi/agent/plans/session-1.md";

function enabledState(): PlanModeState {
	const state = createPlanState();
	state.enabled = true;
	state.planFilePath = PLAN_PATH;
	return state;
}

function event(toolName: string, input: Record<string, unknown>): ToolCallEvent {
	return { type: "tool_call", toolCallId: "call-1", toolName, input } as ToolCallEvent;
}

describe("isSafeCommand", () => {
	it("allows read-only commands", () => {
		for (const cmd of ["ls -la", "cat file.ts", "git status", "git log --oneline", "rg foo src/", "sed -n 1,5p f"]) {
			assert.ok(isSafeCommand(cmd), `expected safe: ${cmd}`);
		}
	});

	it("blocks mutating commands", () => {
		for (const cmd of [
			"rm -rf node_modules",
			"git commit -m x",
			"git push origin main",
			"echo x > file.txt",
			"npm install",
			"touch a",
			"mv a b",
		]) {
			assert.ok(!isSafeCommand(cmd), `expected blocked: ${cmd}`);
		}
	});

	it("blocks commands that only match a safe prefix but contain a destructive part", () => {
		assert.ok(!isSafeCommand("cat file && rm other"));
		assert.ok(!isSafeCommand("ls; git add ."));
	});
});

describe("gateToolCall", () => {
	it("is a no-op when plan mode is off", () => {
		const state = createPlanState();
		assert.equal(gateToolCall(event("bash", { command: "rm -rf /" }), state, CWD), undefined);
		assert.equal(gateToolCall(event("write", { path: "a.ts", content: "x" }), state, CWD), undefined);
	});

	it("allows built-in read-only tools", () => {
		const state = enabledState();
		assert.equal(gateToolCall(event("read", { path: "a.ts" }), state, CWD), undefined);
		assert.equal(gateToolCall(event("grep", { pattern: "x" }), state, CWD), undefined);
		assert.equal(gateToolCall(event("find", { pattern: "*.ts" }), state, CWD), undefined);
		assert.equal(gateToolCall(event("ls", { path: "." }), state, CWD), undefined);
	});

	it("allows edit/write only to the plan file", () => {
		const state = enabledState();
		assert.equal(gateToolCall(event("write", { path: PLAN_PATH, content: "# plan" }), state, CWD), undefined);
		assert.equal(gateToolCall(event("edit", { path: PLAN_PATH, edits: [] }), state, CWD), undefined);
		// Legacy edit input key.
		assert.equal(
			gateToolCall(event("edit", { file_path: PLAN_PATH, oldText: "a", newText: "b" }), state, CWD),
			undefined,
		);
		// Relative path escaping to the plan file location is not a match.
		const blockedWrite = gateToolCall(event("write", { path: "src/a.ts", content: "x" }), state, CWD);
		assert.equal(blockedWrite?.block, true);
		assert.match(blockedWrite?.reason ?? "", /Plan mode is active/);
		assert.match(blockedWrite?.reason ?? "", /ExitPlanMode/);
		const blockedEdit = gateToolCall(event("edit", { path: "../other.md", edits: [] }), state, CWD);
		assert.equal(blockedEdit?.block, true);
	});

	it("restricts bash to the read-only allowlist", () => {
		const state = enabledState();
		assert.equal(gateToolCall(event("bash", { command: "git status" }), state, CWD), undefined);
		const blocked = gateToolCall(event("bash", { command: "npm install" }), state, CWD);
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason ?? "", /npm install/);
	});

	it("blocks powershell outright", () => {
		const state = enabledState();
		const blocked = gateToolCall(event("powershell", { command: "Get-ChildItem" }), state, CWD);
		assert.equal(blocked?.block, true);
	});

	it("allows only the explore subagent", () => {
		const state = enabledState();
		assert.equal(
			gateToolCall(event("subagent", { description: "d", prompt: "p", agent: "explore" }), state, CWD),
			undefined,
		);
		const worker = gateToolCall(event("subagent", { description: "d", prompt: "p" }), state, CWD);
		assert.equal(worker?.block, true);
		assert.match(worker?.reason ?? "", /bypass plan mode/);
	});

	it("blocks unknown custom tools but allows the plan-mode, task, and ask_user tools", () => {
		const state = enabledState();
		for (const name of [
			"EnterPlanMode",
			"ExitPlanMode",
			"TaskCreate",
			"TaskUpdate",
			"TaskList",
			"TaskGet",
			"ask_user",
		]) {
			assert.equal(gateToolCall(event(name, {}), state, CWD), undefined, `expected allowed: ${name}`);
		}
		const blocked = gateToolCall(event("some_other_tool", {}), state, CWD);
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason ?? "", /some_other_tool/);
	});
});
