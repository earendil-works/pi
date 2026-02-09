import type { AssistantMessage } from "@kennyfrc/mu-ai";
import type { Component } from "@kennyfrc/mu-tui";
import { Container, Markdown } from "@kennyfrc/mu-tui";

import { describe, expect, it } from "vitest";

import { AssistantMessageComponent } from "../src/tui/assistant-message.js";

function findFirstMarkdown(component: Component): Markdown | null {
	if (component instanceof Markdown) return component;
	if (component instanceof Container) {
		for (const child of component.children) {
			const found = findFirstMarkdown(child);
			if (found) return found;
		}
	}
	return null;
}

describe("AssistantMessageComponent", () => {
	it("reuses Markdown instances across updateContent when block signature is unchanged", () => {
		const component = new AssistantMessageComponent();

		const msg1: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text" as const, text: "hello" }],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		component.updateContent(msg1);
		const md1 = findFirstMarkdown(component);
		expect(md1).not.toBeNull();

		const msg2: AssistantMessage = {
			...msg1,
			content: [{ type: "text" as const, text: "hello world" }],
		};
		component.updateContent(msg2);
		const md2 = findFirstMarkdown(component);

		expect(md2).not.toBeNull();
		expect(md2).toBe(md1);
	});
});
