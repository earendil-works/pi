import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { extractThinkingPreview, WorkProcessComponent } from "../src/modes/interactive/components/work-process.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

initTheme();

function createAssistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "stopReason">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		stopReason: "stop",
		...overrides,
	};
}

function createToolComponent(name: string): ToolExecutionComponent {
	return new ToolExecutionComponent(name, `call-${name}`, {}, {}, undefined, {} as never, "/tmp");
}

describe("WorkProcessComponent", () => {
	test("collapsed render is a single summary line with tool counts", () => {
		const group = new WorkProcessComponent();
		const assistant = new AssistantMessageComponent();
		assistant.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: "Let me check the render pipeline first." }]),
		);
		group.addChild(assistant);
		group.setThinkingPreview(
			extractThinkingPreview(
				createAssistantMessage([{ type: "thinking", thinking: "Let me check the render pipeline first." }]),
			) ?? "",
		);
		group.trackTool("read");
		group.trackTool("bash");
		group.trackTool("bash");
		group.setCompleted(Date.now());

		group.setCollapsed(true);
		const lines = group.render(80);
		expect(lines).toHaveLength(1);
		const text = stripAnsi(lines[0] ?? "");
		expect(text).toContain("▶");
		expect(text).toContain("read");
		expect(text).toContain("bash×2");
		expect(text).toContain("thinking: Let me check the render pipeline first.");
	});

	test("expanded render shows header plus all children", () => {
		const group = new WorkProcessComponent();
		const assistant = new AssistantMessageComponent();
		assistant.updateContent(createAssistantMessage([{ type: "text", text: "Working on it." }]));
		group.addChild(assistant);
		group.trackTool("bash");
		group.setCompleted(Date.now());

		const lines = group.render(80).map(stripAnsi);
		expect(lines[0]).toContain("▼");
		const text = lines.join("\n");
		expect(text).toContain("Working on it.");
		expect(text).toContain("bash");
	});

	test("history groups without startedAt omit the duration", () => {
		const group = new WorkProcessComponent();
		group.trackTool("read");
		group.setCollapsed(true);
		const text = stripAnsi(group.render(80)[0] ?? "");
		expect(text).not.toContain("Worked");
		expect(text).toContain("read");
	});

	test("click on header toggles collapse", () => {
		const group = new WorkProcessComponent();
		const assistant = new AssistantMessageComponent();
		assistant.updateContent(createAssistantMessage([{ type: "text", text: "hello" }]));
		group.addChild(assistant);
		group.trackTool("read");
		group.render(80);

		const click = {
			type: "click" as const,
			button: "left" as const,
			x: 0,
			y: 0,
			screenX: 0,
			screenY: 0,
			width: 80,
			height: 10,
			shift: false,
			alt: false,
			ctrl: false,
		};
		const result = group.handleMouse(click);
		expect(result?.handled).toBe(true);
		expect(group.isCollapsed()).toBe(true);

		const lines = group.render(80);
		expect(lines).toHaveLength(1);

		group.handleMouse(click);
		expect(group.isCollapsed()).toBe(false);
		expect(group.render(80).length).toBeGreaterThan(1);
	});

	test("clicks below the header are forwarded to children", () => {
		const group = new WorkProcessComponent();
		const tool = createToolComponent("read");
		tool.updateResult({ content: [{ type: "text", text: "line\n".repeat(30) }], isError: false });
		group.addChild(tool);
		group.trackTool("read");
		const lines = group.render(80);
		expect(lines.length).toBeGreaterThan(2);

		const click = {
			type: "click" as const,
			button: "left" as const,
			x: 0,
			y: 2,
			screenX: 0,
			screenY: 2,
			width: 80,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
		};
		group.handleMouse(click);
	});

	test("unregistered tool fallback truncates output while collapsed", () => {
		const tool = createToolComponent("unknown-tool");
		tool.updateResult({ content: [{ type: "text", text: "out\n".repeat(30) }], isError: false });

		const collapsedLines = tool.render(80).map(stripAnsi).join("\n");
		expect(collapsedLines).toContain("more lines");

		tool.setExpanded(true);
		const expandedLines = tool.render(80).map(stripAnsi).join("\n");
		expect(expandedLines).not.toContain("more lines");
		expect(expandedLines.split("out").length).toBeGreaterThan(28);
	});

	test("extractThinkingPreview returns the first sentence", () => {
		const message = createAssistantMessage([{ type: "thinking", thinking: "First idea.\nSecond thought." }]);
		expect(extractThinkingPreview(message)).toBe("First idea.");
	});

	test("extractThinkingPreview skips empty thinking", () => {
		const message = createAssistantMessage([{ type: "thinking", thinking: "  " }]);
		expect(extractThinkingPreview(message)).toBeUndefined();
	});
});
