import {
	type AutocompleteProvider,
	Container,
	Editor,
	setKeybindings,
	Text,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./harness.ts";

const fixtures: Harness[] = [];
beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	for (const harness of fixtures.splice(0)) harness.cleanup();
});

type CommandHost = { setupEditorSubmitHandler(): void; createBaseAutocompleteProvider(): AutocompleteProvider };

async function fixture() {
	const harness = await createHarness({
		models: [{ id: "reasoning", reasoning: true }],
		settings: { defaultThinkingLevel: "low" },
	});
	fixtures.push(harness);
	harness.session.agent.state.model = { ...harness.getModel(), thinkingLevelMap: { xhigh: "xhigh", max: "max" } };
	await harness.session.bindExtensions({});
	const tui = new TuiMainScreen(new VirtualTerminal(80, 24));
	const editor = new Editor(tui, getEditorTheme());
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	// Mount the real interactive handlers over a local session without starting a terminal or auth flow.
	const host = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session: harness.session },
		defaultEditor: editor,
		editor,
		editorContainer,
		ui: tui,
		chatContainer: new Container(),
		footer: new Text(""),
		keybindings: new KeybindingsManager(),
		skillCommands: new Map(),
		fdPath: null,
		outputPad: 0,
	}) as CommandHost;
	host.setupEditorSubmitHandler();
	const submit = (command: string) => {
		editor.setText(command);
		editor.handleInput("\r");
	};
	return { harness, tui, host, submit };
}

describe("native effort command", () => {
	it("keeps max distinct from xhigh and shares the active level with /thinking", async () => {
		const { harness, submit } = await fixture();
		submit("/effort max");
		await vi.waitFor(() => expect(harness.session.thinkingLevel).toBe("max"));
		submit("/thinking xhigh");
		await vi.waitFor(() => expect(harness.session.thinkingLevel).toBe("xhigh"));
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("low");
		expect(harness.eventsOfType("turn_start")).toHaveLength(0);
	});

	it("rejects an unsupported level without silently clamping or changing the active level", async () => {
		const { harness, submit } = await fixture();
		harness.session.agent.state.model = { ...harness.getModel(), thinkingLevelMap: { max: null, xhigh: null } };
		submit("/effort medium");
		await vi.waitFor(() => expect(harness.session.thinkingLevel).toBe("medium"));
		submit("/effort max");
		expect(harness.session.thinkingLevel).toBe("medium");
		expect(harness.eventsOfType("turn_start")).toHaveLength(0);
	});

	it("opens the native picker and preserves its explicit save-as-default action", async () => {
		const { harness, tui, submit } = await fixture();
		harness.session.setThinkingLevel("medium", { persist: false });
		submit("/effort");
		tui.getFocusedComponent()?.handleInput?.("\x1b[B");
		tui.getFocusedComponent()?.handleInput?.("\r");
		expect(harness.session.thinkingLevel).toBe("high");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("low");
		submit("/effort");
		tui.getFocusedComponent()?.handleInput?.("\x1b[A");
		tui.getFocusedComponent()?.handleInput?.("\x13");
		expect(harness.session.thinkingLevel).toBe("medium");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("medium");
	});

	it("completes only levels supported by the current model", async () => {
		const { harness, host } = await fixture();
		const provider = host.createBaseAutocompleteProvider();
		const line = "/effort ";
		const available = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
		expect(available?.items.map((item) => item.value)).toContain("max");
		harness.session.agent.state.model = { ...harness.getModel(), thinkingLevelMap: { max: null, xhigh: null } };
		const limited = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
		expect(limited?.items.map((item) => item.value)).toEqual(["off", "minimal", "low", "medium", "high"]);
	});
});
