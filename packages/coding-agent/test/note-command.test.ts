import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@kennyfrc/mu-agent-core";
import { getModel } from "@kennyfrc/mu-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/settings-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

interface SlashCommandEntry {
	name: string;
}

interface TestEditorView {
	setText(text: string): void;
	getText(): string;
	onSubmit?: (text: string) => void | Promise<void>;
}

interface TestContainerView {
	render(width: number): string[];
}

interface TestUiView {
	start(): void;
	stop(): void;
	requestRender(): void;
	render(width: number): string[];
}

interface RendererTestView {
	builtInSlashCommands: SlashCommandEntry[];
	editor: TestEditorView;
	chatContainer: TestContainerView;
	ui: TestUiView;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function createRenderer(baseDir: string): { renderer: TuiRenderer; view: RendererTestView } {
	const agent = new Agent({
		transport: {
			async *run() {
				yield* [];
			},
		} as never,
		initialState: {
			model: getModel("openai", "gpt-5.1-codex"),
		},
	});

	const renderer = new TuiRenderer(
		agent,
		{
			loadTitle: () => null,
			getSessionId: () => "test-session",
		} as never,
		new SettingsManager(baseDir),
		{
			listCommands: () => [],
			getCommand: () => undefined,
			applyInputHooks: async (text: string) => ({ handled: false, text }),
			composeToolResultTransformer: <T>(base: T) => base,
		} as never,
		{} as never,
		"0.0.0",
	);

	return {
		renderer,
		view: renderer as unknown as RendererTestView,
	};
}

describe("/note command", () => {
	let previousCwd: string;
	let previousOpenAiApiKey: string | undefined;
	let repoRoot: string;
	let settingsDir: string;

	beforeEach(() => {
		initTheme("dark");
		previousCwd = process.cwd();
		previousOpenAiApiKey = process.env.OPENAI_API_KEY;

		repoRoot = mkdtempSync(join(tmpdir(), "mu-note-command-"));
		settingsDir = join(repoRoot, ".mu-agent-test");

		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		writeFileSync(join(repoRoot, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
		mkdirSync(settingsDir, { recursive: true });

		process.chdir(repoRoot);
		process.env.OPENAI_API_KEY = "test-openai-key";
	});

	afterEach(() => {
		process.chdir(previousCwd);
		if (previousOpenAiApiKey === undefined) {
			delete process.env.OPENAI_API_KEY;
		} else {
			process.env.OPENAI_API_KEY = previousOpenAiApiKey;
		}
		rmSync(repoRoot, { recursive: true, force: true });
	});

	it("registers /note as a built-in slash command", () => {
		const { renderer, view } = createRenderer(settingsDir);

		try {
			expect(view.builtInSlashCommands.map((command) => command.name)).toContain("note");
		} finally {
			renderer.stop();
		}
	});

	it("handles /note locally through TuiRenderer instead of forwarding it to the model", async () => {
		const { renderer, view } = createRenderer(settingsDir);
		view.ui.start = () => {};
		view.ui.stop = () => {};
		view.ui.requestRender = () => {};

		try {
			await renderer.init();

			let submittedToModel: string | undefined;
			void renderer.getUserInput().then((text) => {
				submittedToModel = text;
			});

			view.editor.setText("/note Remember to check the README before editing");
			const submit = view.editor.onSubmit;
			expect(submit).toBeTypeOf("function");

			await submit?.(view.editor.getText());
			await Promise.resolve();

			const renderedChat = stripAnsi(view.chatContainer.render(100).join("\n"));

			expect(submittedToModel).toBeUndefined();
			expect(view.editor.getText()).toBe("");
			expect(renderedChat.toLowerCase()).toContain("note");
			expect(renderedChat).toContain("Remember to check the README before editing");
		} finally {
			renderer.stop();
		}
	});

	it("opens /note as a centered floating dialog instead of a full-width editor panel", async () => {
		const { renderer, view } = createRenderer(settingsDir);
		view.ui.start = () => {};
		view.ui.stop = () => {};
		view.ui.requestRender = () => {};

		try {
			await renderer.init();

			view.editor.setText("/note");
			const submit = view.editor.onSubmit;
			expect(submit).toBeTypeOf("function");

			await submit?.(view.editor.getText());
			expect((renderer as any).noteOverlay).toBeTruthy();
			expect((view.ui as any).overlay?.component).toBe((renderer as any).noteOverlay);
		} finally {
			renderer.stop();
		}
	});
});
