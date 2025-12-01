import { type Component, Container, Spacer, Text } from "@mariozechner/pi-tui";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

interface UserMessageItem {
	index: number; // Index in the full messages array
	text: string; // The message text
	timestamp?: string; // Optional timestamp if available
}

/**
 * Custom user message list component with selection
 */
class UserMessageList implements Component {
	private messages: UserMessageItem[] = [];
	private selectedIndex: number = 0;
	public onSelect?: (messageIndex: number) => void;
	public onCancel?: () => void;
	private maxVisible: number = 10; // Max messages visible

	constructor(messages: UserMessageItem[]) {
		// Store messages in chronological order (oldest to newest)
		this.messages = messages;
		// Start with the last (most recent) message selected
		this.selectedIndex = Math.max(0, messages.length - 1);
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const lines: string[] = [];

		if (this.messages.length === 0) {
			lines.push(theme.fg("muted", "  No user messages found"));
			return lines;
		}

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.messages.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.messages.length);

		// Render visible messages (2 lines per message + blank line)
		for (let i = startIndex; i < endIndex; i++) {
			const message = this.messages[i];
			const isSelected = i === this.selectedIndex;

			// Normalize message to single line
			const normalizedMessage = message.text.replace(/\n/g, " ").trim();

			// First line: cursor + message
			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
			const maxMsgWidth = width - 2; // Account for cursor
			const truncatedMsg = normalizedMessage.substring(0, maxMsgWidth);
			const messageLine = cursor + (isSelected ? theme.bold(truncatedMsg) : truncatedMsg);

			lines.push(messageLine);

			// Second line: metadata (position in history)
			const position = i + 1;
			const metadata = `  Message ${position} of ${this.messages.length}`;
			const metadataLine = theme.fg("muted", metadata);
			lines.push(metadataLine);
			lines.push(""); // Blank line between messages
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.messages.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.messages.length})`);
			lines.push(scrollInfo);
		}

		return lines;
	}

	handleInput(keyData: string): void {
		// Up arrow - go to previous (older) message, wrap to bottom when at top
		if (keyData === "\x1b[A") {
			this.selectedIndex = this.selectedIndex === 0 ? this.messages.length - 1 : this.selectedIndex - 1;
		}
		// Down arrow - go to next (newer) message, wrap to top when at bottom
		else if (keyData === "\x1b[B") {
			this.selectedIndex = this.selectedIndex === this.messages.length - 1 ? 0 : this.selectedIndex + 1;
		}
		// Enter - select message and branch
		else if (keyData === "\r") {
			const selected = this.messages[this.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.index);
			}
		}
		// Escape - cancel
		else if (keyData === "\x1b") {
			if (this.onCancel) {
				this.onCancel();
			}
		}
		// Ctrl+C - cancel
		else if (keyData === "\x03") {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}
}

/**
 * Component that renders a user message selector for branching
 */
export class UserMessageSelectorComponent extends Container {
	private messageList: UserMessageList;

	constructor(messages: UserMessageItem[], onSelect: (messageIndex: number) => void, onCancel: () => void) {
		super();

		// Add header
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Branch from Message"), 1, 0));
		this.addChild(new Text(theme.fg("muted", "Select a message to create a new branch from that point"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Create message list
		this.messageList = new UserMessageList(messages);
		this.messageList.onSelect = onSelect;
		this.messageList.onCancel = onCancel;

		this.addChild(this.messageList);

		// Add bottom border
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		// Auto-cancel if no messages or only one message
		if (messages.length <= 1) {
			setTimeout(() => onCancel(), 100);
		}
	}

	getMessageList(): UserMessageList {
		return this.messageList;
	}
}
