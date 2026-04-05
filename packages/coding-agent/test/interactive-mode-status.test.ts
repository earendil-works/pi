import { Container, Text } from "@mariozechner/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function renderLastLine(container: Container, width = 120): string {
	const last = container.children[container.children.length - 1];
	if (!last) return "";
	return last.render(width).join("\n");
}

function renderAll(container: Container, width = 120): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

function createCustomMessageContext(renderer?: (message: { details?: unknown }) => Text) {
	return {
		chatContainer: new Container(),
		session: {
			extensionRunner: renderer ? { getMessageRenderer: () => renderer } : undefined,
		},
		toolOutputExpanded: false,
		getMarkdownThemeWithSettings: () => undefined,
	};
}

function addCustomMessage(
	context: ReturnType<typeof createCustomMessageContext>,
	message: {
		role: "custom";
		customType: string;
		content: string;
		display: boolean;
		details?: unknown;
		timestamp: number;
	},
): void {
	(InteractiveMode as any).prototype.addMessageToChat.call(context, message);
}

describe("InteractiveMode.showStatus", () => {
	beforeAll(() => {
		// showStatus uses the global theme instance
		initTheme("dark");
	});

	test("coalesces immediately-sequential status messages", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_ONE");

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// second status updates the previous line instead of appending
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
		expect(renderLastLine(fakeThis.chatContainer)).not.toContain("STATUS_ONE");
	});

	test("appends a new status line if something else was added in between", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);

		// Something else gets added to the chat in between status updates
		fakeThis.chatContainer.addChild({ render: () => ["OTHER"], invalidate: () => {} });
		expect(fakeThis.chatContainer.children).toHaveLength(3);

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// adds spacer + text
		expect(fakeThis.chatContainer.children).toHaveLength(5);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
	});
});

describe("InteractiveMode.addMessageToChat custom messages", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("updates the last visible custom message when a hidden update arrives", () => {
		const context = createCustomMessageContext();

		addCustomMessage(context, {
			role: "custom",
			customType: "subagent-slash-result",
			content: "placeholder",
			display: true,
			timestamp: 1,
		});

		expect(context.chatContainer.children).toHaveLength(1);

		addCustomMessage(context, {
			role: "custom",
			customType: "subagent-slash-result",
			content: "final",
			display: false,
			timestamp: 2,
		});

		expect(context.chatContainer.children).toHaveLength(1);
		const output = renderAll(context.chatContainer);
		expect(output).toContain("final");
		expect(output).not.toContain("placeholder");
	});

	test("matches by requestId when multiple visible custom messages share the same type", () => {
		const context = createCustomMessageContext((message) => {
			const details = (message.details as { requestId?: string; state?: string } | undefined) ?? {};
			return new Text(`id:${details.requestId ?? "none"} state:${details.state ?? "none"}`, 0, 0);
		});

		addCustomMessage(context, {
			role: "custom",
			customType: "subagent-slash-result",
			content: "placeholder-a",
			display: true,
			details: { requestId: "req-a", state: "running" },
			timestamp: 1,
		});
		addCustomMessage(context, {
			role: "custom",
			customType: "subagent-slash-result",
			content: "placeholder-b",
			display: true,
			details: { requestId: "req-b", state: "running" },
			timestamp: 2,
		});
		addCustomMessage(context, {
			role: "custom",
			customType: "subagent-slash-result",
			content: "final-a",
			display: false,
			details: { requestId: "req-a", state: "done" },
			timestamp: 3,
		});

		const output = renderAll(context.chatContainer);
		expect(output).toContain("id:req-a state:done");
		expect(output).toContain("id:req-b state:running");
		expect(output).not.toContain("id:req-a state:running");
	});

	test("does not fall back to type-only matching when hidden update has unmatched requestId", () => {
		const context = createCustomMessageContext((message) => {
			const details = (message.details as { requestId?: string; state?: string } | undefined) ?? {};
			return new Text(`id:${details.requestId ?? "none"} state:${details.state ?? "none"}`, 0, 0);
		});

		addCustomMessage(context, {
			role: "custom",
			customType: "subagent-slash-result",
			content: "placeholder-a",
			display: true,
			details: { requestId: "req-a", state: "running" },
			timestamp: 1,
		});
		addCustomMessage(context, {
			role: "custom",
			customType: "subagent-slash-result",
			content: "placeholder-b",
			display: true,
			details: { requestId: "req-b", state: "running" },
			timestamp: 2,
		});
		addCustomMessage(context, {
			role: "custom",
			customType: "subagent-slash-result",
			content: "final-c",
			display: false,
			details: { requestId: "req-c", state: "done" },
			timestamp: 3,
		});

		const output = renderAll(context.chatContainer);
		expect(output).toContain("id:req-a state:running");
		expect(output).toContain("id:req-b state:running");
		expect(output).not.toContain("id:req-a state:done");
		expect(output).not.toContain("id:req-b state:done");
		expect(output).not.toContain("id:req-c state:done");
	});

	test("updates custom-rendered message details when hidden update arrives", () => {
		const context = createCustomMessageContext((message) => {
			const details = (message.details as { state?: string } | undefined) ?? {};
			return new Text(`state:${details.state ?? "none"}`, 0, 0);
		});

		addCustomMessage(context, {
			role: "custom",
			customType: "subagent-slash-result",
			content: "placeholder",
			display: true,
			details: { state: "running" },
			timestamp: 1,
		});
		addCustomMessage(context, {
			role: "custom",
			customType: "subagent-slash-result",
			content: "final",
			display: false,
			details: { state: "done" },
			timestamp: 2,
		});

		const output = renderAll(context.chatContainer);
		expect(output).toContain("state:done");
		expect(output).not.toContain("state:running");
	});

	test("ignores hidden custom messages when no visible component exists", () => {
		const context = createCustomMessageContext();

		addCustomMessage(context, {
			role: "custom",
			customType: "subagent-slash-result",
			content: "hidden",
			display: false,
			timestamp: 1,
		});

		expect(context.chatContainer.children).toHaveLength(0);
	});
});

describe("InteractiveMode.createExtensionUIContext setTheme", () => {
	test("persists theme changes to settings manager", () => {
		initTheme("dark");

		let currentTheme = "dark";
		const settingsManager = {
			getTheme: vi.fn(() => currentTheme),
			setTheme: vi.fn((theme: string) => {
				currentTheme = theme;
			}),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("light");

		expect(result.success).toBe(true);
		expect(settingsManager.setTheme).toHaveBeenCalledWith("light");
		expect(currentTheme).toBe("light");
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("does not persist invalid theme names", () => {
		initTheme("dark");

		const settingsManager = {
			getTheme: vi.fn(() => "dark"),
			setTheme: vi.fn(),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("__missing_theme__");

		expect(result.success).toBe(false);
		expect(settingsManager.setTheme).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode.showLoadedResources", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	function createShowLoadedResourcesThis(options: {
		quietStartup: boolean;
		verbose?: boolean;
		skills?: Array<{ filePath: string }>;
		skillDiagnostics?: Array<{ type: "warning" | "error" | "collision"; message: string }>;
	}) {
		const fakeThis: any = {
			options: { verbose: options.verbose ?? false },
			chatContainer: new Container(),
			settingsManager: {
				getQuietStartup: () => options.quietStartup,
			},
			session: {
				promptTemplates: [],
				extensionRunner: undefined,
				resourceLoader: {
					getPathMetadata: () => new Map(),
					getAgentsFiles: () => ({ agentsFiles: [] }),
					getSkills: () => ({
						skills: options.skills ?? [],
						diagnostics: options.skillDiagnostics ?? [],
					}),
					getPrompts: () => ({ prompts: [], diagnostics: [] }),
					getExtensions: () => ({ extensions: [], errors: [], runtime: {} }),
					getThemes: () => ({ themes: [], diagnostics: [] }),
				},
			},
			formatDisplayPath: (p: string) => p,
			buildScopeGroups: () => [],
			formatScopeGroups: () => "resource-list",
			getShortPath: (p: string) => p,
			formatDiagnostics: () => "diagnostics",
			getBuiltInCommandConflictDiagnostics: () => [],
		};

		return fakeThis;
	}

	test("does not show verbose listing on quiet startup during reload", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			extensions: [{ path: "/tmp/ext/index.ts" }],
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		expect(fakeThis.chatContainer.children).toHaveLength(0);
	});

	test("still shows diagnostics on quiet startup when requested", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md" }],
			skillDiagnostics: [{ type: "warning", message: "duplicate skill name" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Skill conflicts]");
		expect(output).not.toContain("[Skills]");
	});
});
