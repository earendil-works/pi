import type { AssistantMessage } from "@kennyfrc/mu-ai";
import { Container, Markdown, Spacer, Text } from "@kennyfrc/mu-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;

	constructor(message?: AssistantMessage) {
		super();

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	updateContent(message: AssistantMessage): void {
		// Clear content container
		this.contentContainer.clear();

		if (
			message.content.length > 0 &&
			message.content.some(
				(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
			)
		) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		for (const content of message.content) {
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(
					new Markdown(content.text.trim(), 1, 0, getMarkdownTheme(), undefined, { renderHtml: true }),
				);
			} else if (content.type === "thinking" && content.thinking.trim()) {
				// Thinking traces in muted color, italic
				// Use Markdown component with default text style for consistent styling
				this.contentContainer.addChild(
					new Markdown(
						content.thinking.trim(),
						1,
						0,
						getMarkdownTheme(),
						{
							color: (text: string) => theme.fg("muted", text),
							italic: true,
						},
						{ renderHtml: true },
					),
				);
				this.contentContainer.addChild(new Spacer(1));
			}
		}

		// Check if aborted - show after partial content
		// But only if there are no tool calls (tool execution components will show the error)
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				this.contentContainer.addChild(new Text(theme.fg("error", "\nAborted"), 1, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0));
			}
		}
	}
}
