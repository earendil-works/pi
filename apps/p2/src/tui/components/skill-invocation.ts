// Copied from coding-agent interactive/components/skill-invocation-message.ts and core/agent-session.ts
// (`parseSkillBlock`): a user message that invokes a skill (`/skill:name`, p2-tui-port.md 10.8) shows the skill as a
// collapsed block in the custom-message colors; the user's own text follows as a normal user message.
import { Box, Container, Markdown, Text } from "@earendil-works/pi-tui";
import { lineText, type RenderContext, safeText } from "../render-context.ts";

export type ParsedSkillBlock = { name: string; location: string; content: string; userMessage: string | undefined };

/** pi's `parseSkillBlock`: the whole text is a skill block, optionally followed by the user's text. */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return { name: match[1]!, location: match[2]!, content: match[3]!, userMessage: match[4]?.trim() || undefined };
}

export class SkillInvocationComponent extends Box {
	private expanded = false;
	private readonly block: ParsedSkillBlock;
	private readonly ctx: RenderContext;
	constructor(block: ParsedSkillBlock, ctx: RenderContext, outputPad = 1) {
		super(outputPad, 1, (text) => ctx.theme.current.bg("customMessageBg", text));
		this.block = block;
		this.ctx = ctx;
		this.updateDisplay();
	}
	setExpanded(expanded: boolean): void {
		if (expanded === this.expanded) return;
		this.expanded = expanded;
		this.updateDisplay();
	}
	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}
	private updateDisplay(): void {
		this.clear();
		const theme = this.ctx.theme.current;
		const content = new Container();
		const label = theme.fg("customMessageLabel", theme.bold("[skill]"));
		if (this.expanded) {
			content.addChild(new Text(label, 0, 0));
			content.addChild(
				new Markdown(
					`**${safeText(this.block.name)}**\n\n${safeText(this.block.content)}`,
					0,
					0,
					this.ctx.theme.markdown,
					{
						color: (text: string) => theme.fg("customMessageText", text),
					},
				),
			);
		} else
			content.addChild(
				new Text(
					`${label} ${theme.fg("customMessageText", lineText(this.block.name))}${theme.fg("dim", ` (${this.ctx.keyText("app.tools.expand")} to expand)`)}`,
					0,
					0,
				),
			);
		this.addChild(content);
	}
}
