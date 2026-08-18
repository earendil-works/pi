/**
 * Debug script to reproduce streaming rendering issues.
 * Uses real fixture data that caused the bug.
 * Run with: npx tsx test/streaming-render-debug.ts
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ProcessTerminal, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize dark theme with full color support
process.env.COLORTERM = "truecolor";
initTheme("dark");

// Load the real fixture that caused the bug
const fixtureMessage: AssistantMessage = JSON.parse(
	readFileSync(join(__dirname, "fixtures/assistant-message-with-thinking-code.json"), "utf-8"),
);

// Extract thinking and text content
const thinkingContent = fixtureMessage.content.find((c) => c.type === "thinking");
const textContent = fixtureMessage.content.find((c) => c.type === "text");

if (!thinkingContent || thinkingContent.type !== "thinking") {
	console.error("No thinking content in fixture");
	process.exit(1);
}

const fullThinkingText = thinkingContent.thinking;
const fullTextContent = textContent && textContent.type === "text" ? textContent.text : "";

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
	const terminal = new ProcessTerminal();
	const tui: TUI = new TuiMainScreen(terminal);

	// Start with empty message
	const message = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "" }],
	} as AssistantMessage;

	const component = new AssistantMessageComponent(message, false);
	tui.addChild(component);
	tui.start();

	// Simulate streaming thinking content
	let thinkingBuffer = "";
	const chunkSize = 10; // characters per "token"

	for (let i = 0; i < fullThinkingText.length; i += chunkSize) {
		thinkingBuffer += fullThinkingText.slice(i, i + chunkSize);

		// Update message content
		const updatedMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: thinkingBuffer }],
		} as AssistantMessage;

		component.updateContent(updatedMessage);
		tui.requestRender();

		await sleep(15); // Simulate token delay
	}

	// Now add the text content
	await sleep(500);

	const finalMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: fullThinkingText },
			{ type: "text", text: fullTextContent },
		],
	} as AssistantMessage;

	component.updateContent(finalMessage);
	tui.requestRender();

	// Keep alive for a moment to see the result
	await sleep(3000);

	tui.stop();
	process.exit(0);
}

main().catch(console.error);
