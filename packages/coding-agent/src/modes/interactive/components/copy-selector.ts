import { Container, SelectList, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../../utils/ansi.ts";
import type { CopyItem } from "../copy-items.ts";
import { icon } from "../icons.ts";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

/** Select a code block, quote, or whole response, with a preview of the clipboard content. */
export class CopySelectorComponent extends Container {
	readonly capturesViewportInput: boolean = true;
	private readonly items: CopyItem[];
	private readonly selectList: SelectList;
	private readonly preview: Text;

	constructor(items: CopyItem[], onSelect: (item: CopyItem) => void, onCancel: () => void) {
		super();
		this.items = items;
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold("Copy from last response"), 0, 0));
		this.addChild(new Spacer(1));
		this.selectList = new SelectList(
			items.map((item, index) => ({
				value: String(index),
				label: stripAnsi(item.label),
				description: item.kind === "whole" ? "Original Markdown" : stripAnsi(item.text).replace(/\s+/g, " ").trim(),
			})),
			6,
			getSelectListTheme(),
			{
				minPrimaryColumnWidth: 20,
				maxPrimaryColumnWidth: 36,
				truncatePrimary: ({ text, maxWidth, item }) => {
					const kind = this.items[Number(item.value)].kind;
					return truncateToWidth(`${icon(kind === "whole" ? "copy" : kind)} ${text}`, maxWidth, "");
				},
			},
		);
		this.selectList.onSelect = (selected) => onSelect(this.items[Number(selected.value)]);
		this.selectList.onCancel = onCancel;
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "Preview"), 0, 0));
		this.preview = new Text("", 0, 0);
		this.addChild(this.preview);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					`${keyDisplayText("tui.select.up")}/${keyDisplayText("tui.select.down")} select · ${keyDisplayText("tui.select.confirm")} copy · ${keyDisplayText("tui.select.cancel")} cancel`,
				),
				0,
				0,
			),
		);
		this.addChild(new DynamicBorder());
	}

	override render(width: number): string[] {
		const selected = this.selectList.getSelectedItem();
		if (selected) {
			const lines = stripAnsi(this.items[Number(selected.value)].text).split("\n", 5);
			const preview = lines
				.slice(0, 4)
				.map((line) => truncateToWidth(line.replace(/\t/g, "   "), Math.max(1, width)));
			if (lines.length > 4) preview.push(theme.fg("muted", "…"));
			this.preview.setText(preview.join("\n") || theme.fg("muted", "(empty)"));
		}
		return super.render(width);
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}
