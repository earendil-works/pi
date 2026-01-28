import { type Component, Container, Input, Spacer, Text } from "@kennyfrc/mu-tui";
import type { SessionManager } from "../session-manager.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

interface SessionItem {
	path: string;
	id: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
}

/**
 * Custom session list component with multi-line items and search
 */
class SessionList implements Component {
	private allSessions: SessionItem[] = [];
	private filteredSessions: SessionItem[] = [];
	private selectedIndex: number = 0;
	private searchInput: Input;
	public onSelect?: (sessionPath: string) => void;
	public onCancel?: () => void;
	private maxVisible: number = 5; // Max sessions visible (each session is 3 lines: msg + metadata + blank)

	constructor(sessions: SessionItem[]) {
		this.allSessions = sessions;
		this.filteredSessions = sessions;
		this.searchInput = new Input();

		// Handle Enter in search input - select current item
		this.searchInput.onSubmit = () => {
			if (this.filteredSessions[this.selectedIndex]) {
				const selected = this.filteredSessions[this.selectedIndex];
				if (this.onSelect) {
					this.onSelect(selected.path);
				}
			}
		};
	}

	private filterSessions(query: string): void {
		if (!query.trim()) {
			this.filteredSessions = this.allSessions;
		} else {
			const searchTokens = query
				.toLowerCase()
				.split(/\s+/)
				.filter((t) => t);
			this.filteredSessions = this.allSessions.filter((session) => {
				// Search through all messages in the session
				const searchText = session.allMessagesText.toLowerCase();
				return searchTokens.every((token) => searchText.includes(token));
			});
		}

		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredSessions.length - 1));
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// Render search input
		lines.push(...this.searchInput.render(width));
		lines.push(""); // Blank line after search

		if (this.filteredSessions.length === 0) {
			lines.push(theme.fg("muted", "  No threads found"));
			return lines;
		}

		// Format dates
		const formatDate = (date: Date): string => {
			const now = new Date();
			const diffMs = now.getTime() - date.getTime();
			const diffMins = Math.floor(diffMs / 60000);
			const diffHours = Math.floor(diffMs / 3600000);
			const diffDays = Math.floor(diffMs / 86400000);

			if (diffMins < 1) return "just now";
			if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? "s" : ""} ago`;
			if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
			if (diffDays === 1) return "1 day ago";
			if (diffDays < 7) return `${diffDays} days ago`;

			return date.toLocaleDateString();
		};

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredSessions.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredSessions.length);

		// Render visible sessions (2 lines per session + blank line)
		for (let i = startIndex; i < endIndex; i++) {
			const session = this.filteredSessions[i];
			const isSelected = i === this.selectedIndex;

			// Normalize first message to single line
			const normalizedMessage = session.firstMessage.replace(/\n/g, " ").trim();

			// First line: cursor + message
			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
			const maxMsgWidth = width - 2; // Account for cursor
			const truncatedMsg = normalizedMessage.substring(0, maxMsgWidth);
			const messageLine = cursor + (isSelected ? theme.bold(truncatedMsg) : truncatedMsg);

			// Second line: metadata (dimmed)
			const modified = formatDate(session.modified);
			const msgCount = `${session.messageCount} message${session.messageCount !== 1 ? "s" : ""}`;
			const metadata = `  ${modified} · ${msgCount}`;
			const metadataLine = theme.fg("dim", metadata);

			lines.push(messageLine);
			lines.push(metadataLine);
			lines.push(""); // Blank line between sessions
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.filteredSessions.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredSessions.length})`);
			lines.push(scrollInfo);
		}

		return lines;
	}

	handleInput(keyData: string): void {
		// Up arrow
		if (keyData === "\x1b[A") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		}
		// Down arrow
		else if (keyData === "\x1b[B") {
			this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + 1);
		}
		// Enter
		else if (keyData === "\r") {
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.path);
			}
		}
		// Escape - cancel
		else if (keyData === "\x1b") {
			if (this.onCancel) {
				this.onCancel();
			}
		}
		// Ctrl+C - exit process
		else if (keyData === "\x03") {
			process.exit(0);
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterSessions(this.searchInput.getValue());
		}
	}
}

/**
 * Component that renders a session selector
 */
export class SessionSelectorComponent extends Container {
	private sessionList: SessionList;

	constructor(sessionManager: SessionManager, onSelect: (sessionPath: string) => void, onCancel: () => void) {
		super();

		// Load all sessions
		const sessions = sessionManager.loadAllSessions();

		// Add header
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Resume Thread"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Create session list
		this.sessionList = new SessionList(sessions);
		this.sessionList.onSelect = onSelect;
		this.sessionList.onCancel = onCancel;

		this.addChild(this.sessionList);

		// Add bottom border
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		// Auto-cancel if no sessions
		if (sessions.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	getSessionList(): SessionList {
		return this.sessionList;
	}
}
