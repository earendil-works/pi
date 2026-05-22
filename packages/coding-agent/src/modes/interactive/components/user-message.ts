import { Box, Container, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message
 */
function formatPromptLabel(format: string, index: number, timestamp: Date): string {
	const hh = timestamp.getHours().toString().padStart(2, "0");
	const mm = timestamp.getMinutes().toString().padStart(2, "0");
	const ss = timestamp.getSeconds().toString().padStart(2, "0");
	return format.replace(/%num/g, String(index)).replace(/%HH/g, hh).replace(/%mm/g, mm).replace(/%ss/g, ss);
}

export class UserMessageComponent extends Container {
	private contentBox: Box;

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		index?: number,
		timestamp?: Date,
		promptLogFormat?: string,
	) {
		super();
		const prefix =
			promptLogFormat && index !== undefined && timestamp !== undefined
				? `${formatPromptLabel(promptLogFormat, index, timestamp)} `
				: "";
		this.contentBox = new Box(1, 1, (content: string) => theme.bg("userMessageBg", content));
		this.contentBox.addChild(
			new Markdown(prefix + text, 0, 0, markdownTheme, {
				color: (content: string) => theme.fg("userMessageText", content),
			}),
		);
		this.addChild(this.contentBox);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
