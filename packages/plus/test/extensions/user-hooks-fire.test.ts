/**
 * Tests for plus/src/extensions/hooks/fire.ts — fire-and-forget dispatch.
 * Hooks are injected directly (parseSettingsHooks output) and each test
 * hook's command appends the stdin payload to a log file so we can assert
 * what was fired.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { fireUserHooks } from "../../src/extensions/hooks/fire.ts";
import { parseSettingsHooks, type SettingsHook } from "../../src/extensions/hooks/loader.ts";

describe("fireUserHooks", () => {
	let dir: string;
	let logPath: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plus-fire-"));
		logPath = path.join(dir, "log.jsonl");
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function hooks(event: string, matcher: string | undefined, command: string): SettingsHook[] {
		return parseSettingsHooks({
			hooks: { [event]: [{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] }] },
		});
	}

	function logCommand(): string {
		return `cat >> "${logPath}"`;
	}

	function readLog(): Record<string, unknown>[] {
		if (!fs.existsSync(logPath)) return [];
		return fs
			.readFileSync(logPath, "utf8")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	}

	async function waitFor(condition: () => boolean): Promise<void> {
		for (let i = 0; i < 50; i++) {
			if (condition()) return;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}

	async function waitForLog(expected: number): Promise<void> {
		await waitFor(() => readLog().length >= expected);
	}

	async function settle(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	it("spawns matching hooks with the payload on stdin", async () => {
		fireUserHooks("PermissionRequest", { permission: "custom" }, hooks("PermissionRequest", undefined, logCommand()));
		await waitForLog(1);
		const [entry] = readLog();
		assert.equal(entry.hook_event, "PermissionRequest");
		assert.equal(entry.permission, "custom");
		assert.equal(entry.cwd, process.cwd());
	});

	it("includes both tool_name and toolName for PreToolUse", async () => {
		fireUserHooks(
			"PreToolUse",
			{ tool_name: "ask_user", toolName: "ask_user" },
			hooks("PreToolUse", "AskUserQuestion", logCommand()),
		);
		await waitForLog(1);
		const [entry] = readLog();
		assert.equal(entry.tool_name, "ask_user");
		assert.equal(entry.toolName, "ask_user");
	});

	it("does not spawn hooks for other events", async () => {
		fireUserHooks("PermissionRequest", {}, hooks("Stop", undefined, logCommand()));
		await settle();
		assert.deepEqual(readLog(), []);
	});

	it("does not spawn matcher hooks when no tool_name is present", async () => {
		fireUserHooks("PreToolUse", {}, hooks("PreToolUse", "AskUserQuestion", logCommand()));
		await settle();
		assert.deepEqual(readLog(), []);
	});

	it("no-ops when no hooks are configured", async () => {
		fireUserHooks("PermissionRequest", {});
		await settle();
		assert.deepEqual(readLog(), []);
	});

	it("runs several matching hooks for one event", async () => {
		const list = [...hooks("Stop", undefined, logCommand()), ...hooks("Stop", undefined, `echo x >> "${logPath}.2"`)];
		fireUserHooks("Stop", {}, list);
		await waitFor(() => readLog().length >= 1 && fs.existsSync(`${logPath}.2`));
	});
});
