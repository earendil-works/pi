// Copied from coding-agent interactive/components/user-message-selector.ts (`/fork`, p2-tui-port.md section 10.8).
// Changes: the instance theme and keymap (section 5.4) instead of the globals; message text is server text
// (`lineText`); the selector is the focused overlay component itself (`handleInput`), and "No user messages found"
// is the caller's status line instead of an auto-cancel timer.
import { type Component, Container, type Focusable, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { lineText } from "../render-context.ts";
import { DynamicBorder, type SelectorContext } from "./selectors.ts";

export interface UserMessageItem {
	id: number; // Entry ID in the conversation
	text: string; // The message text
}

/**
 * Custom user message list component with selection
 */
class UserMessageList implements Component {
	private messages: UserMessageItem[] = [];
	private selectedIndex = 0;
	public onSelect?: (entryId: number) => void;
	public onCancel?: () => void;
	private maxVisible = 10; // Max messages visible
	private readonly ctx: SelectorContext;

	constructor(ctx: SelectorContext, messages: UserMessageItem[], initialSelectedId?: number) {
		this.ctx = ctx;
		// Store messages in chronological order (oldest to newest)
		this.messages = messages;
		const initialIndex =
			initialSelectedId !== undefined ? messages.findIndex((message) => message.id === initialSelectedId) : -1;
		// Start with selected message if provided, else default to the most recent
		this.selectedIndex = initialIndex >= 0 ? initialIndex : Math.max(0, messages.length - 1);
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const theme = this.ctx.theme.current;
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
			const message = this.messages[i]!;
			const isSelected = i === this.selectedIndex;

			// Normalize message to single line
			const normalizedMessage = lineText(message.text).trim();

			// First line: cursor + message
			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
			const maxMsgWidth = width - 2; // Account for cursor (2 chars)
			const truncatedMsg = truncateToWidth(normalizedMessage, maxMsgWidth);
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
		const kb = this.ctx.keys;
		// Up arrow - go to previous (older) message, wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.messages.length - 1 : this.selectedIndex - 1;
		}
		// Down arrow - go to next (newer) message, wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.messages.length - 1 ? 0 : this.selectedIndex + 1;
		}
		// Enter - select message and branch
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.messages[this.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.id);
			}
		}
		// Escape - cancel
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
		this.ctx.requestRender();
	}
}

/**
 * Component that renders a user message selector for branching
 */
export class UserMessageSelectorComponent extends Container implements Focusable {
	focused = false;
	private messageList: UserMessageList;

	constructor(
		ctx: SelectorContext,
		messages: UserMessageItem[],
		onSelect: (entryId: number) => void,
		onCancel: () => void,
		initialSelectedId?: number,
	) {
		super();
		const theme = ctx.theme.current;

		// Add header
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Fork from Message"), 1, 0));
		this.addChild(
			new Text(
				theme.fg("muted", "Select a user message to copy the active path up to that point into a new session"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(ctx));
		this.addChild(new Spacer(1));

		// Create message list
		this.messageList = new UserMessageList(ctx, messages, initialSelectedId);
		this.messageList.onSelect = onSelect;
		this.messageList.onCancel = onCancel;

		this.addChild(this.messageList);

		// Add bottom border
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(ctx));
	}

	handleInput(data: string): void {
		this.messageList.handleInput(data);
	}
}
