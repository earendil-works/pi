import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type DialogContext = {
	extensionDialogs: Component[];
	editorContainer: Container;
	editor: Component & { getText(): string; setText(text: string): void };
	focused: Component | undefined;
	ui: { setFocus: (component: Component) => void; requestRender: () => void };
	programStatus: { setBlocked: ReturnType<typeof vi.fn> };
	disposeActiveSelector: () => void;
	toggleToolOutputExpansion: () => void;
};

type DialogMethods = {
	showExtensionConfirm(title: string, message: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
	showExtensionCustom<T>(
		factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component,
		options?: { blocked?: { kind: "permission" | "question" | "auth"; message: string } },
	): Promise<T>;
	setCustomEditorComponent(
		factory: ((tui: unknown, theme: unknown, keybindings: unknown) => Component) | undefined,
	): void;
};

function createContext(): DialogContext & DialogMethods {
	const prototype = InteractiveMode.prototype as unknown as Record<string, unknown>;
	let editorText = "";
	const editor = Object.assign(new Text("editor"), {
		getText: () => editorText,
		setText: (text: string) => {
			editorText = text;
		},
	});
	const context: DialogContext = {
		extensionDialogs: [],
		editorContainer: new Container(),
		editor,
		focused: undefined,
		ui: {
			setFocus: (component) => {
				context.focused = component;
			},
			requestRender: vi.fn(),
		},
		programStatus: { setBlocked: vi.fn() },
		disposeActiveSelector: vi.fn(),
		toggleToolOutputExpansion: vi.fn(),
	};
	return new Proxy(context, {
		get(target, key, receiver) {
			if (key in target) return Reflect.get(target, key, receiver);
			const value = prototype[key as string];
			return typeof value === "function" ? value.bind(receiver) : value;
		},
	}) as DialogContext & DialogMethods;
}

function visible(context: DialogContext): string {
	expect(context.editorContainer.children).toEqual([context.focused]);
	return (context.focused?.render(80) ?? []).join("\n");
}

describe("InteractiveMode extension dialogs", () => {
	beforeAll(() => initTheme("dark"));

	// Regression for #11166: a second dialog replaced the first one and the first promise never settled.
	it("shows the earlier confirm again after the later one is answered", async () => {
		const context = createContext();
		const first = context.showExtensionConfirm("First", "first dialog");
		const second = context.showExtensionConfirm("Second", "second dialog");

		expect(visible(context)).toContain("Second");
		expect(context.programStatus.setBlocked).toHaveBeenLastCalledWith("extension-dialog", {
			kind: "permission",
			message: "Second",
		});
		context.focused?.handleInput?.("\x1b");
		await expect(second).resolves.toBe(false);

		expect(visible(context)).toContain("First");
		expect(context.programStatus.setBlocked).toHaveBeenLastCalledWith("extension-dialog", {
			kind: "permission",
			message: "First",
		});
		context.focused?.handleInput?.("\r");
		await expect(first).resolves.toBe(true);
		expect(context.focused).toBe(context.editor);
		expect(context.programStatus.setBlocked).toHaveBeenLastCalledWith("extension-dialog", undefined);
	});

	it("removes a hidden dialog when its signal aborts", async () => {
		const context = createContext();
		const controller = new AbortController();
		const first = context.showExtensionConfirm("First", "first dialog", { signal: controller.signal });
		const second = context.showExtensionConfirm("Second", "second dialog");

		controller.abort();
		await expect(first).resolves.toBe(false);
		expect(visible(context)).toContain("Second");

		context.focused?.handleInput?.("\r");
		await expect(second).resolves.toBe(true);
		expect(context.focused).toBe(context.editor);
	});

	// Regression for #9909: a second inline custom component replaced the first one and the first promise never settled.
	it("stacks concurrent inline custom components", async () => {
		const context = createContext();
		const dones: Array<(result: string) => void> = [];
		const open = (label: string) =>
			context.showExtensionCustom<string>((_tui, _theme, _keybindings, done) => {
				dones.push(done);
				return new Text(label);
			});
		const first = open("custom one");
		const second = open("custom two");
		await vi.waitFor(() => expect(dones).toHaveLength(2));
		await vi.waitFor(() => expect(visible(context)).toContain("custom two"));

		dones[1]("two");
		await expect(second).resolves.toBe("two");
		expect(visible(context)).toContain("custom one");

		dones[0]("one");
		await expect(first).resolves.toBe("one");
		expect(context.focused).toBe(context.editor);
	});

	it("shows a confirm opened from an inline custom component and then restores the component", async () => {
		const context = createContext();
		let confirmed: Promise<boolean> | undefined;
		let done: ((result: string) => void) | undefined;
		const custom = context.showExtensionCustom<string>((_tui, _theme, _keybindings, finish) => {
			done = finish;
			return Object.assign(new Text("custom form"), {
				handleInput: () => {
					confirmed = context.showExtensionConfirm("Discard?", "discard changes");
				},
			});
		});
		await vi.waitFor(() => expect(visible(context)).toContain("custom form"));

		context.focused?.handleInput?.("x");
		expect(visible(context)).toContain("Discard?");
		context.focused?.handleInput?.("\x1b");
		await expect(confirmed).resolves.toBe(false);

		expect(visible(context)).toContain("custom form");
		done?.("kept");
		await expect(custom).resolves.toBe("kept");
		expect(context.focused).toBe(context.editor);
	});

	// Regression for #11428: inline custom dialogs could not report blocked program status.
	it("reports blocked status for an inline custom component that opts in", async () => {
		const context = createContext();
		const dones: Array<(result: string) => void> = [];
		const first = context.showExtensionCustom<string>(
			(_tui, _theme, _keybindings, done) => {
				dones.push(done);
				return new Text("approval");
			},
			{ blocked: { kind: "permission", message: "Approve?" } },
		);
		await vi.waitFor(() => expect(visible(context)).toContain("approval"));
		expect(context.programStatus.setBlocked).toHaveBeenLastCalledWith("extension-dialog", {
			kind: "permission",
			message: "Approve?",
		});

		const loader = context.showExtensionCustom<string>((_tui, _theme, _keybindings, done) => {
			dones.push(done);
			return new Text("loading");
		});
		await vi.waitFor(() => expect(visible(context)).toContain("loading"));
		expect(context.programStatus.setBlocked).toHaveBeenLastCalledWith("extension-dialog", undefined);

		dones[1]("loaded");
		await expect(loader).resolves.toBe("loaded");
		expect(context.programStatus.setBlocked).toHaveBeenLastCalledWith("extension-dialog", {
			kind: "permission",
			message: "Approve?",
		});

		dones[0]("yes");
		await expect(first).resolves.toBe("yes");
		expect(context.focused).toBe(context.editor);
		expect(context.programStatus.setBlocked).toHaveBeenLastCalledWith("extension-dialog", undefined);
	});

	// Regression for #11431: replacing the editor while a dialog was open hid the dialog and left it unanswerable.
	it("keeps an open dialog visible when the editor component is replaced", async () => {
		const context = createContext();
		(context as unknown as { defaultEditor: unknown }).defaultEditor = context.editor;
		const confirmed = context.showExtensionConfirm("Title", "Continue?");
		const customEditor: Component & { getText(): string; setText(text: string): void } = {
			render: () => ["custom editor"],
			invalidate: () => {},
			getText: () => "",
			setText: () => {},
		};
		context.setCustomEditorComponent(() => customEditor);

		expect(visible(context)).toContain("Title");
		context.focused?.handleInput?.("\r");
		await expect(confirmed).resolves.toBe(true);
		expect(context.focused).toBe(customEditor);
		expect(context.editorContainer.children).toEqual([customEditor]);
	});
});
