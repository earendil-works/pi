import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@kennyfrc/mu-agent-core";
import { getModel, type OAuthStorage } from "@kennyfrc/mu-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetOAuthStorage, setOAuthStorage } from "../src/oauth/index.js";
import { SettingsManager } from "../src/settings-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

interface TestEditorView {
	setText(text: string): void;
	getText(): string;
	onSubmit?: (text: string) => void | Promise<void>;
	onTab?: () => void;
}

interface TestUiView {
	start(): void;
	stop(): void;
	requestRender(): void;
}

interface RendererTestView {
	editor: TestEditorView;
	ui: TestUiView;
}

async function pollUntil(predicate: () => boolean, timeoutMs: number = 1_000): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt >= timeoutMs) {
			throw new Error(`Timed out after ${timeoutMs}ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function createRenderer(baseDir: string): { renderer: TuiRenderer; view: RendererTestView; agent: Agent } {
	const agent = new Agent({
		transport: {
			async *run() {
				yield* [];
			},
		} as never,
		initialState: {
			model: getModel("openai-codex", "gpt-5.3-codex-spark"),
		},
	});

	const expandCommand = {
		name: "expand",
		description: "Expand a slash command into a prompt",
		execute: async (
			argString: string,
			ctx: { send(text: string, options?: { kind?: "by-end" | "next" }): Promise<void> },
		) => {
			await ctx.send(`Expanded prompt: ${argString.trim()}`);
		},
	};

	const renderer = new TuiRenderer(
		agent,
		{
			loadTitle: () => null,
			getSessionId: () => "test-session",
		} as never,
		new SettingsManager(baseDir),
		{
			listCommands: () => [expandCommand],
			getCommand: (name: string) => (name === "expand" ? expandCommand : undefined),
			applyInputHooks: async (text: string) => ({ handled: false, text }),
			composeToolResultTransformer: <T>(base: T) => base,
		} as never,
		{} as never,
		"0.0.0",
	);

	return {
		renderer,
		view: renderer as unknown as RendererTestView,
		agent,
	};
}

describe("queued slash commands", () => {
	let previousCwd: string;
	let previousOpenAiApiKey: string | undefined;
	let repoRoot: string;
	let settingsDir: string;

	beforeEach(() => {
		initTheme("dark");
		previousCwd = process.cwd();
		previousOpenAiApiKey = process.env.OPENAI_API_KEY;

		repoRoot = mkdtempSync(join(tmpdir(), "mu-queued-slash-command-"));
		settingsDir = join(repoRoot, ".mu-agent-test");

		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		writeFileSync(join(repoRoot, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
		mkdirSync(settingsDir, { recursive: true });

		process.chdir(repoRoot);
		process.env.OPENAI_API_KEY = "test-openai-key";

		let oauthStorage: OAuthStorage = {
			"openai-codex": {
				accounts: [
					{
						id: "test-codex-account",
						credentials: {
							type: "oauth",
							refresh: "refresh-token",
							access: "access-token",
							expires: Date.now() + 60_000,
							accountId: "test-codex-account",
						},
						label: "Test Codex Account",
					},
				],
				activeAccountId: "test-codex-account",
			},
		};

		setOAuthStorage({
			load: () => oauthStorage,
			save: (storage) => {
				oauthStorage = storage;
			},
		});
	});

	afterEach(() => {
		process.chdir(previousCwd);
		resetOAuthStorage();
		if (previousOpenAiApiKey === undefined) {
			delete process.env.OPENAI_API_KEY;
		} else {
			process.env.OPENAI_API_KEY = previousOpenAiApiKey;
		}
		rmSync(repoRoot, { recursive: true, force: true });
	});

	it("expands extension slash commands before queuing them with Tab while streaming", async () => {
		const { renderer, view, agent } = createRenderer(settingsDir);
		view.ui.start = () => {};
		view.ui.stop = () => {};
		view.ui.requestRender = () => {};

		try {
			await renderer.init();

			agent.state.isStreaming = true;
			view.editor.setText("/expand investigate the queue bug");
			view.editor.onTab?.();

			await pollUntil(() => agent.getQueuedMessages().length === 1);

			const queued = agent.getQueuedMessages();
			expect(queued).toHaveLength(1);
			expect(queued[0]).toMatchObject({
				kind: "by-end",
				text: "Expanded prompt: investigate the queue bug",
			});
			expect(queued[0]?.text).not.toBe("/expand investigate the queue bug");
		} finally {
			renderer.stop();
		}
	});
});
