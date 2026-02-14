import { Container, Markdown, Spacer, Text } from "@kennyfrc/mu-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";

/**
 * Parse user_message_time XML tag from message content.
 * Returns { timestamp, content } where timestamp may be undefined.
 */
function parseMessageTimestamp(text: string): { timestamp: string | undefined; content: string } {
	const match = text.match(/^<user_message_time>([^<]+)<\/user_message_time>\n\n/);
	if (match) {
		return {
			timestamp: match[1],
			content: text.slice(match[0].length),
		};
	}
	return { timestamp: undefined, content: text };
}

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	// User messages are immutable after construction.
	getRevision(): number {
		return 0;
	}

	constructor(text: string, isFirst: boolean) {
		super();

		// Add spacer before user message (except first one)
		if (!isFirst) {
			this.addChild(new Spacer(1));
		}

		// Parse timestamp from message content
		const { timestamp, content } = parseMessageTimestamp(text);

		// Display timestamp if present
		if (timestamp) {
			this.addChild(new Text(theme.fg("muted", timestamp)));
		}

		this.addChild(
			new Markdown(content, 1, 1, getMarkdownTheme(), {
				bgColor: (text: string) => theme.bg("userMessageBg", text),
				color: (text: string) => theme.fg("userMessageText", text),
			}),
		);
	}
}
