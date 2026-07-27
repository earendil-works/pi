import type { Component, EditorComponent } from "@earendil-works/pi-tui";
import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { EditorFactory } from "../src/core/extensions/types.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

class TestEditor implements EditorComponent {
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;
	borderColor?: (text: string) => string;
	private text = "";
	readonly label: string;

	constructor(label: string) {
		this.label = label;
	}

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
	}

	handleInput(): void {}

	invalidate(): void {}

	render(): string[] {
		return [this.label];
	}
}

class TestDefaultEditor extends TestEditor {
	getPaddingX(): number {
		return 1;
	}
}

class TestDialog implements Component {
	readonly dispose = vi.fn();

	invalidate(): void {}

	render(): string[] {
		return ["dialog"];
	}
}

type EditorContext = {
	editorComponentFactory: EditorFactory | undefined;
	defaultEditor: TestDefaultEditor;
	editor: EditorComponent;
	editorContainer: Container;
	ui: {
		setFocus: (component: Component) => void;
		requestRender: () => void;
	};
	keybindings: object;
	autocompleteProvider: undefined;
	extensionSelector?: TestDialog;
};

type InteractiveModePrivate = {
	setCustomEditorComponent(this: EditorContext, factory: EditorFactory | undefined): void;
	hideExtensionSelector(this: EditorContext): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createContext(editorContainer: Container, defaultEditor: TestDefaultEditor): EditorContext {
	return {
		editorComponentFactory: undefined,
		defaultEditor,
		editor: defaultEditor,
		editorContainer,
		ui: {
			setFocus: vi.fn(),
			requestRender: vi.fn(),
		},
		keybindings: {},
		autocompleteProvider: undefined,
	};
}

describe("InteractiveMode custom editor replacement", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("keeps an active selector visible and restores the delayed custom editor when it closes", () => {
		const defaultEditor = new TestDefaultEditor("default editor");
		defaultEditor.setText("draft");
		const selector = new TestDialog();
		const editorContainer = new Container();
		editorContainer.addChild(selector);
		const context = createContext(editorContainer, defaultEditor);
		context.extensionSelector = selector;
		const customEditor = new TestEditor("custom editor");
		const factory: EditorFactory = () => customEditor;

		interactiveModePrototype.setCustomEditorComponent.call(context, factory);

		expect(context.editor).toBe(customEditor);
		expect(customEditor.getText()).toBe("draft");
		expect(editorContainer.children).toEqual([selector]);
		expect(context.ui.setFocus).not.toHaveBeenCalled();

		interactiveModePrototype.hideExtensionSelector.call(context);

		expect(selector.dispose).toHaveBeenCalledOnce();
		expect(editorContainer.children).toEqual([customEditor]);
		expect(context.ui.setFocus).toHaveBeenCalledWith(customEditor);
	});

	it("replaces and focuses the editor immediately when the old editor is displayed", () => {
		const defaultEditor = new TestDefaultEditor("default editor");
		defaultEditor.setText("draft");
		const editorContainer = new Container();
		editorContainer.addChild(defaultEditor);
		const context = createContext(editorContainer, defaultEditor);
		const customEditor = new TestEditor("custom editor");

		interactiveModePrototype.setCustomEditorComponent.call(context, () => customEditor);

		expect(context.editor).toBe(customEditor);
		expect(customEditor.getText()).toBe("draft");
		expect(editorContainer.children).toEqual([customEditor]);
		expect(context.ui.setFocus).toHaveBeenCalledWith(customEditor);
	});
});
