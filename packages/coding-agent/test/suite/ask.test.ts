import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { type Component, setKeybindings, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { ExtensionMode, ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import askExtension from "../../src/extensions/ask/index.ts";
import { setIconPreset } from "../../src/modes/interactive/icons.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult, type Harness } from "./harness.ts";

const fixtures: Harness[] = [];
const panels: (Component & { render(width: number, maxHeight?: number): string[]; dispose?(): void })[] = [];
const keys = new KeybindingsManager();
const html =
	'<form><p>Choose the deployment target.</p><fieldset><legend>Target</legend><label><input name="target" type="radio" value="preview" checked required>Preview</label><label><input name="target" type="radio" value="prod">Production</label></fieldset><label>Instances<input name="instances" type="number" required min="1" max="4"></label></form>';

beforeAll(() => {
	initTheme("dark");
	setKeybindings(keys);
});
afterEach(async () => {
	for (const harness of fixtures.splice(0)) {
		await harness.session.abort();
		harness.cleanup();
	}
	for (const panel of panels.splice(0)) panel.dispose?.();
	setIconPreset("unicode");
});

async function fixture(mode: ExtensionMode = "tui") {
	const harness = await createHarness({
		extensionFactories: [
			askExtension,
			(pi) => {
				pi.registerTool({
					name: "side_effect",
					label: "Side effect",
					description: "Records a side effect",
					parameters: Type.Object({}),
					async execute() {
						return { content: [{ type: "text", text: "SIDE_EFFECT_EXECUTED" }], details: {} };
					},
				});
			},
		],
		settings: { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" },
	});
	fixtures.push(harness);
	const terminal = new VirtualTerminal(80, 24);
	const tui = new TuiMainScreen(terminal);
	const uiContext = createTestUiContext({
		custom: async <T>(factory: Parameters<ExtensionUIContext["custom"]>[0]) =>
			new Promise<T>((resolve, reject) => {
				Promise.resolve(factory(tui, theme, keys, (result) => resolve(result as T))).then((panel) => {
					panels.push(panel);
					tui.setFocus(panel);
				}, reject);
			}),
	});
	await harness.session.bindExtensions({
		mode,
		uiContext,
		abortHandler: () => {
			void harness.session.abort();
		},
	});
	return {
		harness,
		panel: async () => {
			await vi.waitFor(() => expect(panels.length).toBe(1));
			return panels[0];
		},
	};
}

function ask(source = html, siblings = false) {
	return fauxAssistantMessage(
		[
			{ type: "toolCall", id: "ask-call", name: "ask", arguments: { html: source } },
			...(siblings ? [{ type: "toolCall" as const, id: "effect-call", name: "side_effect", arguments: {} }] : []),
		],
		{ stopReason: "toolUse" },
	);
}

describe("native clarification forms", () => {
	it("keeps long context scrollable and shrinks short forms to their content after resize", async () => {
		setIconPreset("nerd");
		const { harness, panel } = await fixture();
		harness.setResponses([
			ask(
				`<form><p>${"Long context. ".repeat(80)}</p><label>Answer<input name="answer" value="yes"></label></form>`,
			),
		]);
		const prompt = harness.session.prompt("Ask");
		const view = await panel();
		const narrow = view.render(30, 8);
		expect(narrow.length).toBeLessThanOrEqual(8);
		expect(narrow.every((line) => visibleWidth(line) <= 30)).toBe(true);
		view.handleInput?.("\t");
		const review = view.render(80, 40);
		expect(review.join("\n")).toContain("Answer:");
		expect(review.length).toBeLessThan(10);
		view.handleInput?.("\x1b");
		await prompt;
	});

	it("waits for explicit submission, validates required answers and sends typed answers to the model", async () => {
		const { harness, panel } = await fixture();
		harness.setResponses([ask(), fauxAssistantMessage("Received the deployment choices")]);
		const prompt = harness.session.prompt("Help me choose");
		const view = await panel();
		expect(view.render(80).join("\n")).toContain("Target");
		view.handleInput?.("\r");
		view.handleInput?.("\r");
		expect(view.render(80).join("\n")).toContain("Review");
		expect(harness.eventsOfType("tool_execution_end")).toHaveLength(0);
		view.handleInput?.("\r");
		await vi.waitFor(() => expect(view.render(80).join("\n")).toContain("an answer is required"));
		view.handleInput?.("3");
		view.handleInput?.("\r");
		view.handleInput?.("\r");
		await prompt;
		expect(JSON.parse(getMessageText(getToolResult(harness, "ask")))).toEqual({ target: "preview", instances: 3 });
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("supports custom choice answers and preserves typed multiline whitespace", async () => {
		const { harness, panel } = await fixture();
		harness.setResponses([
			ask(
				'<form><label><input type="radio" name="choice" value="a">Option A</label><label>Details<textarea name="details"></textarea></label></form>',
			),
			fauxAssistantMessage("Received"),
		]);
		const prompt = harness.session.prompt("Ask");
		const view = await panel();
		view.handleInput?.("\x1b[B");
		view.handleInput?.("\r");
		view.handleInput?.("\x1b[200~my choice\x1b[201~");
		view.handleInput?.("\r");
		view.handleInput?.("\x1b[200~  first\nsecond  \x1b[201~");
		view.handleInput?.("\t");
		view.handleInput?.("\r");
		await prompt;
		expect(JSON.parse(getMessageText(getToolResult(harness, "ask")))).toEqual({
			choice: "my choice",
			details: "  first\nsecond  ",
		});
	});

	it("Escape cancels the form and stops later tool calls in the same batch", async () => {
		const { harness, panel } = await fixture();
		harness.setResponses([ask(html, true), fauxAssistantMessage("Must not continue")]);
		const prompt = harness.session.prompt("Ask before acting");
		const view = await panel();
		view.handleInput?.("\x1b");
		await prompt;
		expect(harness.eventsOfType("tool_execution_start").map((event) => event.toolName)).toEqual(["ask"]);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(getMessageText(getToolResult(harness, "ask"))).toContain("no answers were submitted");
	});

	it("external abort closes the pending form without inventing answers", async () => {
		const { harness, panel } = await fixture();
		harness.setResponses([ask(), fauxAssistantMessage("Must not continue")]);
		const prompt = harness.session.prompt("Ask");
		await panel();
		await harness.session.abort();
		await prompt;
		expect(getMessageText(getToolResult(harness, "ask"))).not.toContain('"target":"preview"');
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it.each(["print", "json", "rpc"] as const)("does not expose interactive questions in %s mode", async (mode) => {
		const { harness } = await fixture(mode);
		expect(harness.session.getActiveToolNames()).not.toContain("ask");
		harness.setResponses([ask(), fauxAssistantMessage("Report the missing information to the parent")]);
		await harness.session.prompt("Work headlessly");
		expect(getToolResult(harness, "ask").isError).toBe(true);
		expect(panels).toHaveLength(0);
	});
});
