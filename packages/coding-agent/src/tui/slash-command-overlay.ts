import type { Component, SlashCommand } from "@kennyfrc/mu-tui";
import { visibleWidth } from "@kennyfrc/mu-tui";

function truncateToWidth(text: string, width: number): string {
	if (visibleWidth(text) <= width) {
		return text;
	}
	if (width <= 1) {
		return "…".slice(0, width);
	}
	let result = "";
	for (const char of text) {
		if (visibleWidth(result + char + "…") > width) {
			break;
		}
		result += char;
	}
	return result + "…";
}

function padToWidth(text: string, width: number): string {
	const truncated = truncateToWidth(text, width);
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

interface SlashCommandOverlayOptions {
	getCommands: () => SlashCommand[];
	onSelect: (command: SlashCommand) => void;
	onCancel: () => void;
	onChange?: () => void;
}

export class SlashCommandOverlayComponent implements Component {
	private readonly getCommands: () => SlashCommand[];
	private readonly onSelect: (command: SlashCommand) => void;
	private readonly onCancel: () => void;
	private readonly onChange?: () => void;
	private query = "";
	private selectedIndex = 0;

	constructor(options: SlashCommandOverlayOptions) {
		this.getCommands = options.getCommands;
		this.onSelect = options.onSelect;
		this.onCancel = options.onCancel;
		this.onChange = options.onChange;
	}

	invalidate(): void {
		// no cached render state
	}

	handleInput(data: string): void {
		if (data === "\x03" || data === "\x1b") {
			this.onCancel();
			return;
		}

		if (data === "\x1b[A") {
			this.moveSelection(-1);
			this.onChange?.();
			return;
		}

		if (data === "\x1b[B") {
			this.moveSelection(1);
			this.onChange?.();
			return;
		}

		if (data === "\r" || data === "\t") {
			const command = this.getFilteredCommands()[this.selectedIndex];
			if (command) {
				this.onSelect(command);
			}
			return;
		}

		if (data === "\x7f") {
			if (this.query.length === 0) {
				this.onCancel();
				return;
			}
			this.query = this.query.slice(0, -1);
			this.selectedIndex = 0;
			this.onChange?.();
			return;
		}

		if (/^[\x20-\x7e]+$/.test(data)) {
			this.query += data;
			this.selectedIndex = 0;
			this.onChange?.();
		}
	}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width);
		const minBodyRows = 6;
		const commands = this.getFilteredCommands();

		const searchLabel = "Search";
		const searchValue = `/${this.query}`;
		const searchLine = `${searchLabel}  ${searchValue}`;
		const separator = "─".repeat(contentWidth);

		const commandRows = commands.slice(0, 4).map((command, index) => {
			const prefix = index === this.selectedIndex ? "→" : " ";
			const name = `/${command.name}`;
			const description = command.description ? ` — ${command.description}` : "";
			return `${prefix} ${name}${description}`;
		});

		if (commandRows.length === 0) {
			commandRows.push("No matching commands");
		}

		const bodyLines = [searchLine, separator, ...commandRows];
		while (bodyLines.length < minBodyRows) {
			bodyLines.push("");
		}

		return bodyLines.map((line) => padToWidth(line, contentWidth));
	}

	private getFilteredCommands(): SlashCommand[] {
		const query = this.query.toLowerCase();
		const commands = this.getCommands()
			.map((command) => {
				if (query.length === 0) {
					return { command, rank: 0 };
				}
				const name = command.name.toLowerCase();
				const description = command.description?.toLowerCase() ?? "";
				if (name.startsWith(query)) {
					return { command, rank: 0 };
				}
				if (name.includes(query)) {
					return { command, rank: 1 };
				}
				if (description.includes(query)) {
					return { command, rank: 2 };
				}
				return null;
			})
			.filter((entry): entry is { command: SlashCommand; rank: number } => entry !== null)
			.sort((a, b) => a.rank - b.rank || a.command.name.localeCompare(b.command.name))
			.map((entry) => entry.command);
		if (this.selectedIndex >= commands.length) {
			this.selectedIndex = Math.max(0, commands.length - 1);
		}
		return commands;
	}

	private moveSelection(delta: number): void {
		const commands = this.getFilteredCommands();
		if (commands.length === 0) return;
		this.selectedIndex = (this.selectedIndex + delta + commands.length) % commands.length;
	}
}
