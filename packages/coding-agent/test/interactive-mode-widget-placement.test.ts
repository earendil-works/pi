import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { ExtensionWidgetOptions } from "../src/core/extensions/types.ts";
import type { EditorBorderContent, EditorBorderSlot } from "../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type WidgetContent =
	| string[]
	| ((
			tui: never,
			theme: never,
	  ) => {
			render(width: number): string[];
			invalidate(): void;
			dispose?(): void;
			handleMouse?(event: never): unknown;
	  });

type WidgetContext = {
	extensionWidgets: Map<
		string,
		{ placement: string; component: { dispose?(): void }; borderContent: EditorBorderContent }
	>;
	editor: object;
	defaultEditor: object;
	widgetContainerAbove: Container;
	widgetContainerBelow: Container;
	ui: { requestRender: () => void };
};

const widgetPrototype = InteractiveMode.prototype as unknown as {
	setExtensionWidget(
		this: WidgetContext,
		key: string,
		content: WidgetContent | undefined,
		options?: ExtensionWidgetOptions,
	): void;
};

function createContext(
	editor: object,
	defaultEditor: object = editor,
): {
	context: WidgetContext;
	above: Container;
	below: Container;
} {
	const above = new Container();
	const below = new Container();
	const context = Object.assign(Object.create(InteractiveMode.prototype), {
		extensionWidgets: new Map(),
		editor,
		defaultEditor,
		widgetContainerAbove: above,
		widgetContainerBelow: below,
		ui: { requestRender: () => {} },
	}) as WidgetContext;
	return { context, above, below };
}

function borderEditor() {
	const slots = new Map<string, EditorBorderContent>();
	return {
		slots,
		setBorderContent: (slot: EditorBorderSlot, key: string, content: EditorBorderContent | undefined) => {
			if (content === undefined) slots.delete(`${slot}:${key}`);
			else slots.set(`${slot}:${key}`, content);
		},
		clearBorderContent: () => slots.clear(),
	};
}

const plainEditor = {
	render: () => [],
	invalidate: () => {},
	getText: () => "",
	setText: () => {},
	handleInput: () => {},
};

describe("InteractiveMode extension widget placement", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("routes border placements to the editor's border slots", () => {
		const editor = borderEditor();
		const { context, above, below } = createContext(editor);

		widgetPrototype.setExtensionWidget.call(context, "w", ["hello", "world"], { placement: "borderTopRight" });

		expect([...editor.slots.keys()]).toEqual(["topRight:w"]);
		expect(editor.slots.get("topRight:w")!.render(80)).toBe("hello");
		expect(above.children).toHaveLength(1); // default spacer only
		expect(below.children).toHaveLength(0);
	});

	it("shows one line of border content and trims component padding", () => {
		const editor = borderEditor();
		const { context } = createContext(editor);

		widgetPrototype.setExtensionWidget.call(
			context,
			"factory",
			() => ({ render: () => ["  padded ", "second"], invalidate: () => {} }),
			{ placement: "borderBottomLeft" },
		);

		expect([...editor.slots.keys()]).toEqual(["bottomLeft:factory"]);
		expect(editor.slots.get("bottomLeft:factory")!.render(80)).toBe("  padded");
	});

	it("forwards border mouse events to the widget component", () => {
		const editor = borderEditor();
		const { context } = createContext(editor);
		const seen: number[] = [];
		widgetPrototype.setExtensionWidget.call(
			context,
			"factory",
			() => ({
				render: () => ["hit"],
				invalidate: () => {},
				handleMouse: (event: { x: number }) => {
					seen.push(event.x);
					return { handled: true };
				},
			}),
			{ placement: "borderTopRight" },
		);

		const content = editor.slots.get("topRight:factory")!;
		expect(content.handleMouse?.({ x: 7 } as never)).toEqual({ handled: true });
		expect(seen).toEqual([7]);
	});

	it("places above/below widgets in the widget containers", () => {
		const editor = borderEditor();
		const { context, above, below } = createContext(editor);

		widgetPrototype.setExtensionWidget.call(context, "top", ["a"]);
		widgetPrototype.setExtensionWidget.call(context, "bottom", ["b"], { placement: "belowEditor" });

		expect(editor.slots.size).toBe(0);
		expect(above.children).toHaveLength(2); // spacer + widget
		expect(below.children).toHaveLength(1);
	});

	it("falls back to the containers when the editor has no border slots", () => {
		const { context, above, below } = createContext(plainEditor);

		widgetPrototype.setExtensionWidget.call(context, "tr", ["top-right"], { placement: "borderTopRight" });
		widgetPrototype.setExtensionWidget.call(context, "bl", ["bottom-left"], { placement: "borderBottomLeft" });

		expect(above.children).toHaveLength(2); // spacer + top border widget
		expect(below.children).toHaveLength(1); // bottom border widget
	});

	it("clears a widget's slot when the key is removed", () => {
		const editor = borderEditor();
		const { context, above } = createContext(editor);

		widgetPrototype.setExtensionWidget.call(context, "w", ["hello"], { placement: "borderTopRight" });
		widgetPrototype.setExtensionWidget.call(context, "w", undefined);

		expect([...editor.slots.keys()]).toEqual([]);
		expect(above.children).toHaveLength(1); // default spacer only
		expect(context.extensionWidgets.size).toBe(0);
	});

	it("replaces a widget's content in place", () => {
		const editor = borderEditor();
		const { context } = createContext(editor);

		widgetPrototype.setExtensionWidget.call(context, "w", ["one"], { placement: "borderTopRight" });
		widgetPrototype.setExtensionWidget.call(context, "w", ["two"], { placement: "borderTopRight" });

		expect([...editor.slots.keys()]).toEqual(["topRight:w"]);
		expect(editor.slots.get("topRight:w")!.render(80)).toBe("two");
		expect(context.extensionWidgets.size).toBe(1);
	});
});
