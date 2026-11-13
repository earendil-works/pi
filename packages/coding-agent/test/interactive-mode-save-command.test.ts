import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

type SaveCommandContext = {
	sessionManager: SessionManager;
	showStatus: (message: string) => void;
	showWarning: (message: string) => void;
	showError: (message: string) => void;
	footer: { invalidate: () => void };
	ui: { requestRender: () => void };
};

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	showError: (message: string) => void;
	handleSaveCommand: () => void;
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
		abort: () => Promise<void>;
	};
	flushPendingBashComponents: () => void;
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

// Private command methods are reached through the real prototype, like other interactive-mode tests.
function callHandleSaveCommand(context: SaveCommandContext): void {
	Reflect.apply(Reflect.get(InteractiveMode.prototype, "handleSaveCommand"), context, []);
}

function callSetupEditorSubmitHandler(context: SubmitContext): void {
	Reflect.apply(Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler"), context, []);
}

let tempRoot: string;
let projectDir: string;
let saveDir: string;

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "pi-save-command-"));
	projectDir = join(tempRoot, "project");
	saveDir = join(tempRoot, "saved-sessions");
	mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
	rmSync(tempRoot, { recursive: true, force: true });
});

function createContext(session: SessionManager): SaveCommandContext {
	return {
		sessionManager: session,
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() },
	};
}

function createSubmitContext(overrides: Partial<SubmitContext> = {}): SubmitContext {
	return {
		defaultEditor: {},
		editor: { addToHistory: vi.fn(), setText: vi.fn() },
		showError: vi.fn(),
		handleSaveCommand: vi.fn(),
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
			abort: vi.fn(async () => {}),
		},
		flushPendingBashComponents: vi.fn(),
		pendingUserInputs: [],
		...overrides,
	};
}

function sessionFileName(session: SessionManager): string {
	const header = session.getHeader();
	if (!header) throw new Error("session has no header");
	return `${header.timestamp.replace(/[:.]/g, "-")}_${session.getSessionId()}.jsonl`;
}

describe("InteractiveMode /save command", () => {
	it("is offered by built-in slash-command autocomplete", () => {
		expect(BUILTIN_SLASH_COMMANDS.map((command) => command.name)).toContain("save");
	});

	it("saves a temporary session and reports the file path", () => {
		// #10768
		const session = SessionManager.inMemory(projectDir, undefined, undefined, saveDir);
		session.appendMessage(userMsg("prompt"));
		session.appendMessage(assistantMsg("reply"));
		const context = createContext(session);

		callHandleSaveCommand(context);

		const expectedPath = join(saveDir, sessionFileName(session));
		expect(context.showError).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith(`Session saved to: ${expectedPath}`);
		expect(context.footer.invalidate).toHaveBeenCalled();
		expect(context.ui.requestRender).toHaveBeenCalled();
		expect(existsSync(expectedPath)).toBe(true);
		expect(session.isPersisted()).toBe(true);
	});

	it("reports an existing save on repeat", () => {
		const session = SessionManager.inMemory(projectDir, undefined, undefined, saveDir);
		session.appendMessage(userMsg("prompt"));
		const context = createContext(session);

		callHandleSaveCommand(context);
		callHandleSaveCommand(context);

		expect(context.showStatus).toHaveBeenLastCalledWith(
			`Session already saved to: ${join(saveDir, sessionFileName(session))}`,
		);
	});

	it("warns when there is nothing to save", () => {
		const session = SessionManager.inMemory(projectDir, undefined, undefined, saveDir);
		session.appendThinkingLevelChange("high");
		const context = createContext(session);

		callHandleSaveCommand(context);

		expect(context.showWarning).toHaveBeenCalledWith("Nothing to save yet: send a message first");
		expect(context.showStatus).not.toHaveBeenCalled();
		expect(existsSync(saveDir)).toBe(false);
	});

	it("keeps the session unsaved after a failure and saves on retry", () => {
		// #10768
		const session = SessionManager.inMemory(projectDir, { id: "command-retry" }, undefined, saveDir);
		session.appendMessage(userMsg("prompt"));
		mkdirSync(saveDir, { recursive: true });
		const blockedPath = join(saveDir, sessionFileName(session));
		writeFileSync(blockedPath, "sentinel\n");
		const context = createContext(session);

		callHandleSaveCommand(context);

		expect(context.showError).toHaveBeenCalledWith(
			expect.stringContaining(`Failed to save session: Could not write session file ${blockedPath}`),
		);
		expect(session.isPersisted()).toBe(false);
		expect(session.getSessionFile()).toBeUndefined();
		// Conversation stays usable while the session is still temporary.
		session.appendMessage(assistantMsg("reply"));
		expect(session.getEntries()).toHaveLength(2);

		rmSync(blockedPath);
		callHandleSaveCommand(context);

		expect(context.showStatus).toHaveBeenCalledWith(`Session saved to: ${blockedPath}`);
		expect(session.isPersisted()).toBe(true);
	});
});

describe("InteractiveMode /save dispatch", () => {
	it("handles a bare /save without sending a prompt", async () => {
		const context = createSubmitContext();
		callSetupEditorSubmitHandler(context);

		await context.defaultEditor.onSubmit?.("/save");

		expect(context.handleSaveCommand).toHaveBeenCalledTimes(1);
		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(context.session.prompt).not.toHaveBeenCalled();
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("rejects arguments with a usage error", async () => {
		const context = createSubmitContext();
		callSetupEditorSubmitHandler(context);

		await context.defaultEditor.onSubmit?.("/save now");
		await context.defaultEditor.onSubmit?.("/save\tpath.jsonl");

		expect(context.handleSaveCommand).not.toHaveBeenCalled();
		expect(context.showError).toHaveBeenCalledTimes(2);
		expect(context.showError).toHaveBeenCalledWith("Usage: /save");
		expect(context.session.prompt).not.toHaveBeenCalled();
	});

	it("treats trailing whitespace as no arguments", async () => {
		const context = createSubmitContext();
		callSetupEditorSubmitHandler(context);

		await context.defaultEditor.onSubmit?.("  /save\t ");

		expect(context.handleSaveCommand).toHaveBeenCalledTimes(1);
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("does not treat a longer command name as /save", async () => {
		const onInputCallback = vi.fn();
		const context = createSubmitContext({ onInputCallback });
		callSetupEditorSubmitHandler(context);

		await context.defaultEditor.onSubmit?.("/savepoint");

		expect(context.handleSaveCommand).not.toHaveBeenCalled();
		expect(context.showError).not.toHaveBeenCalled();
		expect(onInputCallback).toHaveBeenCalledWith("/savepoint");
	});

	it("saves while a response is streaming without steering or aborting it", async () => {
		const context = createSubmitContext();
		context.session.isStreaming = true;
		callSetupEditorSubmitHandler(context);

		await context.defaultEditor.onSubmit?.("/save");

		expect(context.handleSaveCommand).toHaveBeenCalledTimes(1);
		expect(context.session.prompt).not.toHaveBeenCalled();
		expect(context.session.abort).not.toHaveBeenCalled();
	});
});
