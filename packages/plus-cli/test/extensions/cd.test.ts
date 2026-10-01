/**
 * Tests for plus/src/extensions/cd/index.ts — the /cd command that relocates
 * the session file to a different working directory and switches to it.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "../../../coding-agent/src/core/extensions/types.ts";
import { getDefaultSessionDir } from "../../../coding-agent/src/core/session-manager.ts";
import { registerCd } from "../../src/extensions/cd/index.ts";

interface Notify {
	message: string;
	type?: string;
}

interface FakeState {
	notifies: Notify[];
	switchCalls: Array<{ path: string; withSession?: (ctx: ExtensionCommandContext) => Promise<void> }>;
	cancelSwitch: boolean;
	sessionFile: string | undefined;
}

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

function captureCd() {
	let command: { name: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> } | undefined;
	const pi = {
		registerCommand: (
			name: string,
			options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
		) => {
			command = { name, handler: options.handler };
		},
	} as unknown as ExtensionAPI;
	registerCd(pi);
	return {
		run: (args: string, ctx: ExtensionCommandContext) => {
			assert.ok(command, "command registered");
			return command.handler(args, ctx);
		},
	};
}

function fakeCtx(cwd: string, state: FakeState): ExtensionCommandContext {
	const notify = (message: string, type?: string) => {
		state.notifies.push({ message, type });
	};
	return {
		cwd,
		waitForIdle: async () => {},
		sessionManager: { getSessionFile: () => state.sessionFile },
		ui: { notify },
		switchSession: async (
			path: string,
			options?: { withSession?: (ctx: ExtensionCommandContext) => Promise<void> },
		) => {
			state.switchCalls.push({ path, withSession: options?.withSession });
			if (!state.cancelSwitch) {
				await options?.withSession?.({ ui: { notify } } as unknown as ExtensionCommandContext);
			}
			return { cancelled: state.cancelSwitch };
		},
	} as unknown as ExtensionCommandContext;
}

let root: string;
let dirA: string;
let dirB: string;
let savedAgentDir: string | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-plus-cd-"));
	dirA = join(root, "alpha");
	dirB = join(root, "beta");
	mkdirSync(dirA, { recursive: true });
	mkdirSync(dirB, { recursive: true });
	savedAgentDir = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = join(root, "agent");
});

afterEach(() => {
	if (savedAgentDir === undefined) {
		delete process.env[ENV_AGENT_DIR];
	} else {
		process.env[ENV_AGENT_DIR] = savedAgentDir;
	}
});

const HEADER_ID = "01a0d6f7-4830-76ff-905d-d33e39e072f2";
const HEADER_TS = "2026-09-25T05:08:45.232Z";

function makeSessionFile(cwd: string): string {
	const sessionDir = getDefaultSessionDir(cwd);
	const file = join(sessionDir, `${HEADER_TS.replace(/[:.]/g, "-")}_${HEADER_ID}.jsonl`);
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id: HEADER_ID, timestamp: HEADER_TS, cwd }),
			'{"type":"model_change","id":"2c0eb918","parentId":null,"timestamp":"2026-09-25T05:08:45.258Z","provider":"faux","modelId":"faux-1"}',
			'{"type":"message","id":"a1fbe7d1","parentId":"2c0eb918","timestamp":"2026-09-25T05:08:45.259Z","message":{"role":"user","content":"hello"}}',
			"",
		].join("\n"),
	);
	return file;
}

describe("/cd", () => {
	it("registers the cd command", () => {
		const pi = {
			registerCommand: (name: string, _options: unknown) => {
				assert.equal(name, "cd");
			},
		} as unknown as ExtensionAPI;
		registerCd(pi);
	});

	it("with no argument, shows the current cwd and does not switch", async () => {
		const state: FakeState = { notifies: [], switchCalls: [], cancelSwitch: false, sessionFile: undefined };
		await captureCd().run("   ", fakeCtx(dirA, state));
		assert.equal(state.switchCalls.length, 0);
		assert.deepEqual(state.notifies, [{ message: `cwd: ${dirA} — usage: /cd <dir>`, type: "info" }]);
	});

	it("warns and does not switch when the target does not exist", async () => {
		const state: FakeState = { notifies: [], switchCalls: [], cancelSwitch: false, sessionFile: undefined };
		await captureCd().run("missing", fakeCtx(dirA, state));
		assert.equal(state.switchCalls.length, 0);
		assert.equal(state.notifies.length, 1);
		assert.equal(state.notifies[0].type, "warning");
		assert.match(state.notifies[0].message, /Not a directory/);
	});

	it("warns when the target is a file, not a directory", async () => {
		const file = join(root, "afile");
		writeFileSync(file, "x");
		const state: FakeState = { notifies: [], switchCalls: [], cancelSwitch: false, sessionFile: undefined };
		await captureCd().run("afile", fakeCtx(dirA, state));
		assert.equal(state.switchCalls.length, 0);
		assert.equal(state.notifies[0].type, "warning");
	});

	it("no-ops when the target is the current cwd", async () => {
		const state: FakeState = { notifies: [], switchCalls: [], cancelSwitch: false, sessionFile: undefined };
		await captureCd().run(dirA, fakeCtx(dirA, state));
		assert.equal(state.switchCalls.length, 0);
		assert.match(state.notifies[0].message, /Already in/);
	});

	it("resolves relative targets against the current cwd", async () => {
		const state: FakeState = { notifies: [], switchCalls: [], cancelSwitch: false, sessionFile: undefined };
		await captureCd().run("../beta", fakeCtx(dirA, state));
		assert.equal(state.switchCalls.length, 1);
		const newFile = state.switchCalls[0].path;
		assert.ok(
			newFile.startsWith(getDefaultSessionDir(dirB)),
			`expected file under target session dir, got ${newFile}`,
		);
	});

	it("moves the session: header cwd rewritten, id/timestamp/entries preserved, old file removed", async () => {
		const oldFile = makeSessionFile(dirA);
		const oldContent = readFileSync(oldFile, "utf8");
		const state: FakeState = { notifies: [], switchCalls: [], cancelSwitch: false, sessionFile: oldFile };
		await captureCd().run(dirB, fakeCtx(dirA, state));

		assert.equal(state.switchCalls.length, 1);
		const newFile = state.switchCalls[0].path;
		assert.equal(newFile, join(getDefaultSessionDir(dirB), `${HEADER_TS.replace(/[:.]/g, "-")}_${HEADER_ID}.jsonl`));
		assert.ok(existsSync(newFile));
		assert.ok(!existsSync(oldFile), "old session file removed after the switch");

		const lines = readFileSync(newFile, "utf8").split("\n");
		const header = JSON.parse(lines[0]) as Record<string, unknown>;
		assert.equal(header.type, "session");
		assert.equal(header.id, HEADER_ID, "same session id");
		assert.equal(header.timestamp, HEADER_TS, "same timestamp");
		assert.equal(header.cwd, dirB, "header cwd rewritten");
		// Entries after the header are byte-identical to the original.
		assert.equal(lines.slice(1).join("\n"), oldContent.split("\n").slice(1).join("\n"));

		assert.deepEqual(state.notifies, [{ message: `Working directory: ${dirB}`, type: "info" }]);
	});

	it("keeps the copy and warns when the switch is cancelled", async () => {
		const oldFile = makeSessionFile(dirA);
		const state: FakeState = { notifies: [], switchCalls: [], cancelSwitch: true, sessionFile: oldFile };
		await captureCd().run(dirB, fakeCtx(dirA, state));

		assert.ok(existsSync(oldFile), "original kept on cancelled switch");
		const newFile = state.switchCalls[0].path;
		assert.ok(existsSync(newFile), "copy kept on cancelled switch");
		assert.equal(state.notifies[0].type, "warning");
		assert.match(state.notifies[0].message, /Switch cancelled/);
	});

	it("starts directly in the target dir when the session has no file yet", async () => {
		const state: FakeState = { notifies: [], switchCalls: [], cancelSwitch: false, sessionFile: undefined };
		await captureCd().run(dirB, fakeCtx(dirA, state));

		assert.equal(state.switchCalls.length, 1);
		const newFile = state.switchCalls[0].path;
		const header = JSON.parse(readFileSync(newFile, "utf8").split("\n")[0]) as Record<string, unknown>;
		assert.equal(header.type, "session");
		assert.equal(header.cwd, dirB);
		assert.equal(readFileSync(newFile, "utf8").trim().split("\n").length, 1);
		assert.deepEqual(state.notifies, [{ message: `Working directory: ${dirB}`, type: "info" }]);
	});

	it("warns on an invalid session header without switching", async () => {
		const sessionDir = getDefaultSessionDir(dirA);
		const badFile = join(sessionDir, "bad.jsonl");
		writeFileSync(badFile, '{"type":"not-a-session"}\n');
		const state: FakeState = { notifies: [], switchCalls: [], cancelSwitch: false, sessionFile: badFile };
		await captureCd().run(dirB, fakeCtx(dirA, state));
		assert.equal(state.switchCalls.length, 0);
		assert.equal(state.notifies[0].type, "error");
	});

	it("regenerates the filename on collision in the target session dir", async () => {
		const oldFile = makeSessionFile(dirA);
		// Pre-create a file with the name the move would use.
		const targetSessionDir = getDefaultSessionDir(dirB);
		writeFileSync(join(targetSessionDir, `${HEADER_TS.replace(/[:.]/g, "-")}_${HEADER_ID}.jsonl`), "occupied\n");
		const state: FakeState = { notifies: [], switchCalls: [], cancelSwitch: false, sessionFile: oldFile };
		await captureCd().run(dirB, fakeCtx(dirA, state));

		const newFile = state.switchCalls[0].path;
		assert.notEqual(newFile, join(targetSessionDir, `${HEADER_TS.replace(/[:.]/g, "-")}_${HEADER_ID}.jsonl`));
		assert.ok(existsSync(newFile));
		const header = JSON.parse(readFileSync(newFile, "utf8").split("\n")[0]) as Record<string, unknown>;
		assert.equal(header.id, HEADER_ID);
		assert.equal(header.cwd, dirB);
	});
});
