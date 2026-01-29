import type { Component } from "../tui.js";

export interface SelectItem {
	value: string;
	label: string;
	description?: string;
}

export interface SelectListTheme {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
}

export class SelectList implements Component {
	private items: SelectItem[] = [];
	private filteredItems: SelectItem[] = [];
	private selectedIndex: number = 0;
	private maxVisible: number = 5;
	private theme: SelectListTheme;
	private labelMaxWidth: number;

	public onSelect?: (item: SelectItem) => void;
	public onCancel?: () => void;
	public onSelectionChange?: (item: SelectItem) => void;

	constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme, labelMaxWidth = 30) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.labelMaxWidth = labelMaxWidth;
	}

	setFilter(filter: string): void {
		this.filteredItems = this.items.filter((item) => item.value.toLowerCase().startsWith(filter.toLowerCase()));
		// Reset selection when filter changes
		this.selectedIndex = 0;
	}

	setSelectedIndex(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(index, this.filteredItems.length - 1));
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// If no items match filter, show message
		if (this.filteredItems.length === 0) {
			lines.push(this.theme.noMatch("  No matching commands"));
			return lines;
		}

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

		const minWidthForDescription = this.labelMaxWidth + 10;
		const labelColumnWidth = this.labelMaxWidth + 2;

		// Render visible items
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;

			let line = "";
			if (isSelected) {
				// Use arrow indicator for selection - entire line uses selectedText color
				const prefixWidth = 2; // "→ " is 2 characters visually
				const displayValue = item.label || item.value;

				if (item.description && width > minWidthForDescription) {
					// Calculate how much space we have for value + description
					const maxValueLength = Math.min(displayValue.length, this.labelMaxWidth);
					const truncatedValue = displayValue.substring(0, maxValueLength);
					const spacing = " ".repeat(Math.max(1, labelColumnWidth - truncatedValue.length));

					// Calculate remaining space for description using visible widths
					const descriptionStart = prefixWidth + truncatedValue.length + spacing.length;
					const remainingWidth = width - descriptionStart - 2; // -2 for safety

					if (remainingWidth > 10) {
						const truncatedDesc = item.description.substring(0, remainingWidth);
						// Apply selectedText to entire line content
						line = this.theme.selectedText("→ " + truncatedValue + spacing + truncatedDesc);
					} else {
						// Not enough space for description
						const maxWidth = width - prefixWidth - 2;
						line = this.theme.selectedText("→ " + displayValue.substring(0, maxWidth));
					}
				} else {
					// No description or not enough width
					const maxWidth = width - prefixWidth - 2;
					line = this.theme.selectedText("→ " + displayValue.substring(0, maxWidth));
				}
			} else {
				const displayValue = item.label || item.value;
				const prefix = "  ";

				if (item.description && width > minWidthForDescription) {
					// Calculate how much space we have for value + description
					const maxValueLength = Math.min(displayValue.length, this.labelMaxWidth);
					const truncatedValue = displayValue.substring(0, maxValueLength);
					const spacing = " ".repeat(Math.max(1, labelColumnWidth - truncatedValue.length));

					// Calculate remaining space for description
					const descriptionStart = prefix.length + truncatedValue.length + spacing.length;
					const remainingWidth = width - descriptionStart - 2; // -2 for safety

					if (remainingWidth > 10) {
						const truncatedDesc = item.description.substring(0, remainingWidth);
						const descText = this.theme.description(spacing + truncatedDesc);
						line = prefix + truncatedValue + descText;
					} else {
						// Not enough space for description
						const maxWidth = width - prefix.length - 2;
						line = prefix + displayValue.substring(0, maxWidth);
					}
				} else {
					// No description or not enough width
					const maxWidth = width - prefix.length - 2;
					line = prefix + displayValue.substring(0, maxWidth);
				}
			}

			lines.push(line);
		}

		// Add scroll indicators if needed
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${this.filteredItems.length})`;
			// Truncate if too long for terminal
			const maxWidth = width - 2;
			const truncated = scrollText.substring(0, maxWidth);
			lines.push(this.theme.scrollInfo(truncated));
		}

		return lines;
	}

	handleInput(keyData: string): void {
		if (keyData === "\x1b[A") {
			if (this.filteredItems.length > 0) {
				this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			}
			this.notifySelectionChange();
		} else if (keyData === "\x1b[B") {
			if (this.filteredItems.length > 0) {
				this.selectedIndex = this.selectedIndex >= this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			}
			this.notifySelectionChange();
		} else if (keyData === "\r") {
			const selectedItem = this.filteredItems[this.selectedIndex];
			if (selectedItem && this.onSelect) {
				this.onSelect(selectedItem);
			}
		} else if (keyData === "\x1b" || keyData === "\x03") {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}

	private notifySelectionChange(): void {
		const selectedItem = this.filteredItems[this.selectedIndex];
		if (selectedItem && this.onSelectionChange) {
			this.onSelectionChange(selectedItem);
		}
	}

	getSelectedItem(): SelectItem | null {
		const item = this.filteredItems[this.selectedIndex];
		return item || null;
	}
}
