/**
 * Simple chat interface demo using tui.ts
 */

import chalk from "chalk";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";
import { Loader } from "../src/components/loader.ts";
import { Markdown } from "../src/components/markdown.ts";
import { Text } from "../src/components/text.ts";
import { ProcessTerminal } from "../src/terminal.ts";
import type { TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme, defaultMarkdownTheme } from "./test-themes.ts";

// Create terminal
const terminal = new ProcessTerminal();

// Create TUI
const tui: TUI = new TuiMainScreen(terminal);

// Create chat container with some initial messages
tui.addChild(
	new Text("Welcome to Simple Chat!\n\nType your messages below. Type '/' for commands. Press Ctrl+C to exit."),
);

// Create editor with autocomplete
const editor = new Editor(tui, defaultEditorTheme);

// Set up autocomplete provider with slash commands and file completion
const autocompleteProvider = new CombinedAutocompleteProvider(
	[
		{ name: "delete", description: "Delete the last message" },
		{ name: "clear", description: "Clear all messages" },
	],
	process.cwd(),
);
editor.setAutocompleteProvider(autocompleteProvider);

tui.addChild(editor);

// Focus the editor
tui.setFocus(editor);

// Track if we're waiting for bot response
let isResponding = false;

// Handle message submission
editor.onSubmit = (value: string) => {
	// Prevent submission if already responding
	if (isResponding) {
		return;
	}

	const trimmed = value.trim();

	// Handle slash commands
	if (trimmed === "/delete") {
		const children = tui.children;
		// Remove component before editor (if there are any besides the initial text)
		if (children.length > 3) {
			// children[0] = "Welcome to Simple Chat!"
			// children[1] = "Type your messages below..."
			// children[2...n-1] = messages
			// children[n] = editor
			children.splice(children.length - 2, 1);
		}
		tui.requestRender();
		return;
	}

	if (trimmed === "/clear") {
		const children = tui.children;
		// Remove all messages but keep the welcome text and editor
		children.splice(2, children.length - 3);
		tui.requestRender();
		return;
	}

	if (trimmed) {
		isResponding = true;
		editor.disableSubmit = true;

		const userMessage = new Markdown(value, 1, 1, defaultMarkdownTheme);

		const children = tui.children;
		children.splice(children.length - 1, 0, userMessage);

		const loader = new Loader(
			tui,
			(s) => chalk.cyan(s),
			(s) => chalk.dim(s),
			"Thinking...",
		);
		children.splice(children.length - 1, 0, loader);

		tui.requestRender();

		setTimeout(() => {
			tui.removeChild(loader);

			// Simulate a response
			const responses = [
				"That's interesting! Tell me more.",
				"I see what you mean.",
				"Fascinating perspective!",
				"Could you elaborate on that?",
				"That makes sense to me.",
				"I hadn't thought of it that way.",
				"Great point!",
				"Thanks for sharing that.",
			];
			const randomResponse = responses[Math.floor(Math.random() * responses.length)];

			// Add assistant message with no background (transparent)
			const botMessage = new Markdown(randomResponse, 1, 1, defaultMarkdownTheme);
			children.splice(children.length - 1, 0, botMessage);

			// Re-enable submit
			isResponding = false;
			editor.disableSubmit = false;

			// Request render
			tui.requestRender();
		}, 1000);
	}
};

// Start the TUI
tui.start();
