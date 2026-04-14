import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import type { ExtensionUIContext } from "../src/core/extensions/types.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { Theme } from "../src/modes/interactive/theme/theme.js";

/**
 * Tests the slash-command bypass mechanism used by plan-mode.
 *
 * The pattern: an `input` handler detects "/" prefix on the original text
 * (before template expansion) and sets a flag. The `before_agent_start`
 * handler checks this flag and skips auto-activation when set.
 *
 * We test with an inline extension that mirrors the exact mechanism from
 * plan-mode/index.ts, since loading the full plan-mode extension would
 * require complex dependency resolution.
 */

// Inline extension source that mirrors plan-mode's slash command bypass pattern
const slashBypassExtension = `
let inputIsSlashCommand = false;

export default function(pi) {
	pi.on("input", async (event) => {
		inputIsSlashCommand = false;
		if (event.text.startsWith("/") && event.source !== "extension") {
			inputIsSlashCommand = true;
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (inputIsSlashCommand) {
			inputIsSlashCommand = false;
			return;
		}
		return { systemPrompt: "PLAN_MODE_ACTIVE" };
	});
}
`;

// Minimal mock UI context (needed so hasUI is irrelevant — our inline ext doesn't check it)
const mockUIContext: ExtensionUIContext = {
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setHiddenThinkingLabel: () => {},
	setWidget: (() => {}) as ExtensionUIContext["setWidget"],
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	pasteToEditor: () => {},
	setEditorText: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	setEditorComponent: () => {},
	get theme() {
		return undefined as unknown as Theme;
	},
	getAllThemes: () => [],
	getTheme: () => undefined,
	setTheme: () => ({ success: false }),
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

describe("plan-mode slash command bypass", () => {
	let tempDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-slash-bypass-test-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
	});

	afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

	async function createRunner(extensionSource: string) {
		fs.rmSync(extensionsDir, { recursive: true, force: true });
		fs.mkdirSync(extensionsDir);
		fs.writeFileSync(path.join(extensionsDir, "ext.ts"), extensionSource);
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		const sm = SessionManager.inMemory();
		const mr = ModelRegistry.inMemory(AuthStorage.create(path.join(tempDir, "auth.json")));
		const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sm, mr);
		runner.setUIContext(mockUIContext);
		return runner;
	}

	describe("input handler flag behavior", () => {
		it("sets flag for interactive slash commands — before_agent_start skips activation", async () => {
			const runner = await createRunner(slashBypassExtension);
			await runner.emitInput("/review code.ts", undefined, "interactive");
			const result = await runner.emitBeforeAgentStart("Review code.ts for quality...", undefined, "base prompt");
			// No systemPrompt returned means auto-activation was skipped
			expect(result).toBeUndefined();
		});

		it("does not set flag for normal prompts — before_agent_start activates", async () => {
			const runner = await createRunner(slashBypassExtension);
			await runner.emitInput("fix the auth bug", undefined, "interactive");
			const result = await runner.emitBeforeAgentStart("fix the auth bug", undefined, "base prompt");
			expect(result).toBeDefined();
			expect(result!.systemPrompt).toBe("PLAN_MODE_ACTIVE");
		});

		it("does not set flag for extension source — before_agent_start activates", async () => {
			const runner = await createRunner(slashBypassExtension);
			await runner.emitInput("/some-internal-command", undefined, "extension");
			const result = await runner.emitBeforeAgentStart("some-internal-command", undefined, "base prompt");
			expect(result).toBeDefined();
			expect(result!.systemPrompt).toBe("PLAN_MODE_ACTIVE");
		});

		it("sets flag for rpc source slash commands — before_agent_start skips activation", async () => {
			const runner = await createRunner(slashBypassExtension);
			await runner.emitInput("/skill:reviewer spec", undefined, "rpc");
			const result = await runner.emitBeforeAgentStart("Reviewer spec content...", undefined, "base prompt");
			expect(result).toBeUndefined();
		});
	});

	describe("flag lifecycle", () => {
		it("resets flag at start of each input event — stale flag does not persist", async () => {
			const runner = await createRunner(slashBypassExtension);

			// First: slash command sets flag
			await runner.emitInput("/review code.ts", undefined, "interactive");
			// Second: normal prompt resets flag
			await runner.emitInput("fix the bug", undefined, "interactive");

			// before_agent_start should activate (flag was reset by second input)
			const result = await runner.emitBeforeAgentStart("fix the bug", undefined, "base prompt");
			expect(result).toBeDefined();
			expect(result!.systemPrompt).toBe("PLAN_MODE_ACTIVE");
		});

		it("consumes flag after check — second before_agent_start call activates", async () => {
			const runner = await createRunner(slashBypassExtension);

			await runner.emitInput("/review code.ts", undefined, "interactive");

			// First call: flag is set, skips activation
			const result1 = await runner.emitBeforeAgentStart("expanded content", undefined, "base prompt");
			expect(result1).toBeUndefined();

			// Second call without new input: flag was consumed, activates normally
			const result2 = await runner.emitBeforeAgentStart("some other prompt", undefined, "base prompt");
			expect(result2).toBeDefined();
			expect(result2!.systemPrompt).toBe("PLAN_MODE_ACTIVE");
		});

		it("handles empty slash command (just /)", async () => {
			const runner = await createRunner(slashBypassExtension);
			await runner.emitInput("/", undefined, "interactive");
			const result = await runner.emitBeforeAgentStart("", undefined, "base prompt");
			expect(result).toBeUndefined();
		});

		it("does not trigger on text containing / but not starting with it", async () => {
			const runner = await createRunner(slashBypassExtension);
			await runner.emitInput("fix the path/to/file.ts issue", undefined, "interactive");
			const result = await runner.emitBeforeAgentStart("fix the path/to/file.ts issue", undefined, "base prompt");
			expect(result).toBeDefined();
			expect(result!.systemPrompt).toBe("PLAN_MODE_ACTIVE");
		});
	});

	describe("end-to-end flow", () => {
		it("slash command → expanded text → no plan mode activation", async () => {
			const runner = await createRunner(slashBypassExtension);

			// Simulates the full pipeline: user types /review, input sees "/review",
			// template expansion produces "Review the code...", before_agent_start gets expanded text
			await runner.emitInput("/review main.ts", undefined, "interactive");
			const result = await runner.emitBeforeAgentStart(
				"Review the code in main.ts for quality, performance, and correctness.",
				undefined,
				"You are a helpful assistant.",
			);

			// Plan mode should NOT have injected its system prompt
			expect(result).toBeUndefined();
		});

		it("normal prompt → plan mode activates with system prompt", async () => {
			const runner = await createRunner(slashBypassExtension);

			await runner.emitInput("build a REST API with authentication", undefined, "interactive");
			const result = await runner.emitBeforeAgentStart(
				"build a REST API with authentication",
				undefined,
				"You are a helpful assistant.",
			);

			// Plan mode SHOULD have injected its system prompt
			expect(result).toBeDefined();
			expect(result!.systemPrompt).toBe("PLAN_MODE_ACTIVE");
		});

		it("input handler does not consume or transform the input", async () => {
			const runner = await createRunner(slashBypassExtension);

			// The input handler should return void (action: "continue"), not modify text
			const inputResult = await runner.emitInput("/review code.ts", undefined, "interactive");
			expect(inputResult.action).toBe("continue");
		});
	});
});
