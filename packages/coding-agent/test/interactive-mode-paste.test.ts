import {
	type Component,
	Container,
	Editor,
	type EditorComponent,
	getKeybindings,
	setKeybindings,
	type TUI,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { EditorFactory } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme, type Theme } from "../src/modes/interactive/theme/theme.ts";

// Pastes over 10 lines collapse into a marker whose content only the receiving editor can expand.
const COLLAPSED_PASTE_LINE_COUNT = 12;

function pastedText(label: string): string {
	return Array.from({ length: COLLAPSED_PASTE_LINE_COUNT }, (_, i) => `${label} ${i + 1}`).join("\n");
}

function paste(editor: EditorComponent, text: string): void {
	editor.handleInput(`\x1b[200~${text}\x1b[201~`);
	// Without a collapsed marker, the transition under test would copy plain text and prove nothing.
	expect(editor.getText()).not.toBe(text);
}

function submit(editor: EditorComponent): string | undefined {
	let submitted: string | undefined;
	editor.onSubmit = (text) => {
		submitted = text;
	};
	editor.handleInput("\r");
	return submitted;
}

type CustomUiFactory = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: string) => void,
) => Component | Promise<Component>;

// Regression tests for #9809.
describe("InteractiveMode keeps collapsed paste content when it moves a draft", () => {
	let keybindings: KeybindingsManager;
	let previousKeybindings: ReturnType<typeof getKeybindings>;
	let ui: TUI;

	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		previousKeybindings = getKeybindings();
		keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		ui = new TuiMainScreen(new VirtualTerminal());
	});
	afterEach(() => setKeybindings(previousKeybindings));

	test("between the default and a replacement editor", () => {
		const defaultEditor = new CustomEditor(ui, getEditorTheme(), keybindings);
		const editor: EditorComponent = defaultEditor;
		const host = {
			ui,
			keybindings,
			defaultEditor,
			editor,
			editorContainer: new Container(),
			disposeActiveSelector() {},
		};
		const setCustomEditorComponent = Reflect.get(InteractiveMode.prototype, "setCustomEditorComponent") as (
			this: typeof host,
			factory: EditorFactory | undefined,
		) => void;

		const intoReplacement = pastedText("into replacement");
		paste(host.editor, intoReplacement);
		setCustomEditorComponent.call(host, (tui, theme) => new Editor(tui, theme));
		expect(submit(host.editor)).toBe(intoReplacement);

		const backToDefault = pastedText("back to default");
		paste(host.editor, backToDefault);
		setCustomEditorComponent.call(host, undefined);
		expect(submit(host.editor)).toBe(backToDefault);
	});

	describe("around non-overlay custom UI", () => {
		function createHost() {
			return {
				ui,
				keybindings,
				editor: new Editor(ui, getEditorTheme()),
				editorContainer: new Container(),
				disposeActiveSelector() {},
			};
		}
		const showExtensionCustom = Reflect.get(InteractiveMode.prototype, "showExtensionCustom") as (
			this: ReturnType<typeof createHost>,
			factory: CustomUiFactory,
		) => Promise<string>;

		test("after it closes", async () => {
			const host = createHost();
			const draft = pastedText("draft");
			paste(host.editor, draft);
			const component: Component = { render: () => [], invalidate() {} };
			let close = (_result: string): void => {
				throw new Error("custom UI factory was not called");
			};

			const shown = showExtensionCustom.call(host, (_tui, _theme, _keybindings, done) => {
				close = done;
				return component;
			});
			await vi.waitFor(() => expect(host.editorContainer.children[0]).toBe(component));
			close("closed");
			await shown;

			expect(submit(host.editor)).toBe(draft);
		});

		test("after it fails to open", async () => {
			const host = createHost();
			const draft = pastedText("draft");
			paste(host.editor, draft);

			const shown = showExtensionCustom.call(host, async () => {
				throw new Error("factory failed");
			});
			await expect(shown).rejects.toThrow("factory failed");

			expect(submit(host.editor)).toBe(draft);
		});
	});

	test("when queued messages are restored above it", () => {
		const editor = new Editor(ui, getEditorTheme());
		const host = {
			editor,
			clearAllQueues: () => ({ steering: [], followUp: ["queued follow-up"] }),
			updatePendingMessagesDisplay() {},
		};
		const restoreQueuedMessagesToEditor = Reflect.get(InteractiveMode.prototype, "restoreQueuedMessagesToEditor") as (
			this: typeof host,
		) => number;

		const draft = pastedText("draft");
		paste(editor, draft);
		restoreQueuedMessagesToEditor.call(host);

		expect(submit(editor)).toBe(`queued follow-up\n\n${draft}`);
	});
});
