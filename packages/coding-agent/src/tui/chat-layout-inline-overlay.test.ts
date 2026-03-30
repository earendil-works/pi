import { Container, Text } from "@kennyfrc/mu-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { initTheme } from "../theme/theme.js";
import { ChatLayoutComponent } from "./chat-layout.js";

describe("ChatLayoutComponent inline overlay", () => {
	beforeEach(() => {
		initTheme("dark");
	});
	it("should render inline overlay between chat and composer", () => {
		const chatContent = new Container();
		chatContent.addChild(new Text("Chat line 1", 0, 0));
		chatContent.addChild(new Text("Chat line 2", 0, 0));

		const inlineOverlay = new Container();
		inlineOverlay.addChild(new Text("Inline overlay content", 0, 0));

		const composerContent = new Container();
		composerContent.addChild(new Text("Composer", 0, 0));
		composerContent.addChild(new Text("Input here", 0, 0));

		const footer = new Container();
		footer.addChild(new Text("Footer", 0, 0));

		const layout = new ChatLayoutComponent({
			chatContent,
			composerContent,
			inputTarget: composerContent,
			footer,
			getComposerLabel: () => "Input",
			getComposerBorderColor: () => (text: string) => text,
			updateComposerViewport: () => {},
			inlineOverlayContent: inlineOverlay,
		});

		const lines = layout.render(80);
		const text = lines.join("\n");

		// Should contain chat content
		expect(text).toContain("Chat line 1");
		expect(text).toContain("Chat line 2");

		// Should contain inline overlay
		expect(text).toContain("Inline overlay content");

		// Should contain composer
		expect(text).toContain("Input here");

		// Inline overlay should appear BEFORE composer in output
		const chatIndex = text.indexOf("Chat line 1");
		const overlayIndex = text.indexOf("Inline overlay content");
		const composerIndex = text.indexOf("Input here");

		expect(overlayIndex).toBeGreaterThan(chatIndex);
		expect(composerIndex).toBeGreaterThan(overlayIndex);
	});

	it("should work without inline overlay (backward compatibility)", () => {
		const chatContent = new Container();
		chatContent.addChild(new Text("Chat content", 0, 0));

		const composerContent = new Container();
		composerContent.addChild(new Text("Composer", 0, 0));

		const footer = new Container();
		footer.addChild(new Text("Footer", 0, 0));

		const layout = new ChatLayoutComponent({
			chatContent,
			composerContent,
			inputTarget: composerContent,
			footer,
			getComposerLabel: () => "Input",
			getComposerBorderColor: () => (text: string) => text,
			updateComposerViewport: () => {},
			// No inlineOverlayContent provided
		});

		const lines = layout.render(80);
		const text = lines.join("\n");

		expect(text).toContain("Chat content");
		expect(text).toContain("Composer");
	});

	it("should handle Escape key to clear inline overlay", () => {
		// This test verifies the layout can receive input interception
		// The actual dismissal is handled by the caller (TuiRenderer)
		let interceptedData: string | null = null;

		const chatContent = new Container();
		const inlineOverlay = new Container();
		const composerContent = new Container();
		const footer = new Container();

		const layout = new ChatLayoutComponent({
			chatContent,
			composerContent,
			inputTarget: composerContent,
			footer,
			getComposerLabel: () => "Input",
			getComposerBorderColor: () => (text: string) => text,
			updateComposerViewport: () => {},
			inlineOverlayContent: inlineOverlay,
			interceptInput: (data) => {
				interceptedData = data;
				return data; // Pass through
			},
		});

		// Simulate Escape key
		layout.handleInput("\x1b");

		expect(interceptedData).toBe("\x1b");
	});
});
