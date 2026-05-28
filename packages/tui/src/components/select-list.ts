import { EventEmitter } from "node:events";
import { getKeybindings } from "../keybindings.ts";
import type { Component } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";

const DEFAULT_PRIMARY_COLUMN_WIDTH = 32;
const PRIMARY_COLUMN_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 10;

/**
 * Module-scope event bus for SelectList lifecycle, intended for remote-control
 * extensions that want to mirror selectors to a non-TUI client (mobile app, web).
 *
 * Events:
 *   "mount"   ({ id, items })  emitted from the SelectList constructor.
 *   "dismiss" ({ id })         emitted exactly once when the list is resolved
 *                              (selection, cancel, or remote response).
 *
 * Listeners receive the same `id` they can use with `respondToSelectList(id, value)`
 * to drive the selection remotely.
 */
export const selectListEvents = new EventEmitter();

// Registry of live SelectLists by id so a remote client can find one and drive
// its selection. Held by WeakRef (with a FinalizationRegistry) so a list the
// owner drops without an explicit confirm/cancel — there is no Component
// teardown hook to clean up on — can still be garbage-collected and its entry
// reclaimed instead of leaking. Settling a list also removes its entry eagerly.
const liveSelectLists = new Map<string, WeakRef<SelectList>>();
const selectListFinalizer = new FinalizationRegistry<string>((id) => {
	liveSelectLists.delete(id);
});

let __selectListIdCounter = 0;
function nextSelectListId(): string {
	__selectListIdCounter++;
	return `sl_${Date.now().toString(36)}_${__selectListIdCounter.toString(36)}`;
}

/**
 * Resolve a live SelectList from outside the TUI focus stack by id.
 * Pass `value === null` to cancel; otherwise the value is matched against
 * `SelectItem.value` (preferred) or `SelectItem.label` (fallback) before
 * invoking the list's onSelect callback.
 *
 * @returns for a cancel, true if a live list existed; for a selection, true
 *   only if `value` matched an item. false if no live list exists for `id`.
 */
export function respondToSelectList(id: string, value: string | null): boolean {
	const list = liveSelectLists.get(id)?.deref();
	if (!list) return false;
	if (value === null) {
		list.cancelRemote();
		return true;
	}
	return list.selectRemote(value);
}

const normalizeToSingleLine = (text: string): string => text.replace(/[\r\n]+/g, " ").trim();
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

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

export interface SelectListTruncatePrimaryContext {
	text: string;
	maxWidth: number;
	columnWidth: number;
	item: SelectItem;
	isSelected: boolean;
}

export interface SelectListLayoutOptions {
	minPrimaryColumnWidth?: number;
	maxPrimaryColumnWidth?: number;
	truncatePrimary?: (context: SelectListTruncatePrimaryContext) => string;
}

export class SelectList implements Component {
	/** Stable id for this instance. See `selectListEvents` for remote control. */
	public readonly id: string = nextSelectListId();
	private items: SelectItem[] = [];
	private filteredItems: SelectItem[] = [];
	private selectedIndex: number = 0;
	private maxVisible: number = 5;
	private theme: SelectListTheme;
	private layout: SelectListLayoutOptions;
	private dismissed: boolean = false;

	public onSelect?: (item: SelectItem) => void;
	public onCancel?: () => void;
	public onSelectionChange?: (item: SelectItem) => void;

	constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme, layout: SelectListLayoutOptions = {}) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.layout = layout;
		liveSelectLists.set(this.id, new WeakRef(this));
		selectListFinalizer.register(this, this.id, this);
		selectListEvents.emit("mount", { id: this.id, items });
	}

	/**
	 * Transition to the dismissed state exactly once. Returns true if this call
	 * performed the transition (the caller "won the race"), false if the list was
	 * already dismissed. Callers must only fire onSelect/onCancel when this
	 * returns true, so a keyboard confirm and a concurrent remote response can't
	 * both invoke the callback.
	 */
	private settle(): boolean {
		if (this.dismissed) return false;
		this.dismissed = true;
		liveSelectLists.delete(this.id);
		selectListFinalizer.unregister(this);
		selectListEvents.emit("dismiss", { id: this.id });
		return true;
	}

	/**
	 * Drive a selection from outside the TUI (e.g., a phone client).
	 * Matches by `value` first, then `label`.
	 * @returns true if `value` matched an item, false otherwise.
	 */
	selectRemote(value: string): boolean {
		const item = this.items.find((i) => i.value === value) ?? this.items.find((i) => i.label === value);
		if (!item) return false;
		if (this.settle()) this.onSelect?.(item);
		return true;
	}

	/** Drive a cancel from outside the TUI. Fires onCancel if not already dismissed. */
	cancelRemote(): void {
		if (this.settle()) this.onCancel?.();
	}

	/**
	 * Component teardown hook. Called by the TUI's overlay manager when this
	 * list is permanently removed (hide / pop). Settles the list if it hasn't
	 * been already, so `dismiss` fires deterministically on every close path —
	 * not just user pick/cancel and remote response. Does not invoke
	 * onSelect/onCancel: the unmount itself isn't a user choice.
	 */
	dispose(): void {
		this.settle();
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

		const primaryColumnWidth = this.getPrimaryColumnWidth();

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

		// Render visible items
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const descriptionSingleLine = item.description ? normalizeToSingleLine(item.description) : undefined;
			lines.push(this.renderItem(item, isSelected, width, descriptionSingleLine, primaryColumnWidth));
		}

		// Add scroll indicators if needed
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${this.filteredItems.length})`;
			// Truncate if too long for terminal
			lines.push(this.theme.scrollInfo(truncateToWidth(scrollText, width - 2, "")));
		}

		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			this.notifySelectionChange();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			this.notifySelectionChange();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedItem = this.filteredItems[this.selectedIndex];
			if (selectedItem && this.settle()) {
				this.onSelect?.(selectedItem);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.settle()) this.onCancel?.();
		}
	}

	private renderItem(
		item: SelectItem,
		isSelected: boolean,
		width: number,
		descriptionSingleLine: string | undefined,
		primaryColumnWidth: number,
	): string {
		const prefix = isSelected ? "→ " : "  ";
		const prefixWidth = visibleWidth(prefix);

		if (descriptionSingleLine && width > 40) {
			const effectivePrimaryColumnWidth = Math.max(1, Math.min(primaryColumnWidth, width - prefixWidth - 4));
			const maxPrimaryWidth = Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP);
			const truncatedValue = this.truncatePrimary(item, isSelected, maxPrimaryWidth, effectivePrimaryColumnWidth);
			const truncatedValueWidth = visibleWidth(truncatedValue);
			const spacing = " ".repeat(Math.max(1, effectivePrimaryColumnWidth - truncatedValueWidth));
			const descriptionStart = prefixWidth + truncatedValueWidth + spacing.length;
			const remainingWidth = width - descriptionStart - 2; // -2 for safety

			if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
				const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, "");
				if (isSelected) {
					return this.theme.selectedText(`${prefix}${truncatedValue}${spacing}${truncatedDesc}`);
				}

				const descText = this.theme.description(spacing + truncatedDesc);
				return prefix + truncatedValue + descText;
			}
		}

		const maxWidth = width - prefixWidth - 2;
		const truncatedValue = this.truncatePrimary(item, isSelected, maxWidth, maxWidth);
		if (isSelected) {
			return this.theme.selectedText(`${prefix}${truncatedValue}`);
		}

		return prefix + truncatedValue;
	}

	private getPrimaryColumnWidth(): number {
		const { min, max } = this.getPrimaryColumnBounds();
		const widestPrimary = this.filteredItems.reduce((widest, item) => {
			return Math.max(widest, visibleWidth(this.getDisplayValue(item)) + PRIMARY_COLUMN_GAP);
		}, 0);

		return clamp(widestPrimary, min, max);
	}

	private getPrimaryColumnBounds(): { min: number; max: number } {
		const rawMin =
			this.layout.minPrimaryColumnWidth ?? this.layout.maxPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;
		const rawMax =
			this.layout.maxPrimaryColumnWidth ?? this.layout.minPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;

		return {
			min: Math.max(1, Math.min(rawMin, rawMax)),
			max: Math.max(1, Math.max(rawMin, rawMax)),
		};
	}

	private truncatePrimary(item: SelectItem, isSelected: boolean, maxWidth: number, columnWidth: number): string {
		const displayValue = this.getDisplayValue(item);
		const truncatedValue = this.layout.truncatePrimary
			? this.layout.truncatePrimary({
					text: displayValue,
					maxWidth,
					columnWidth,
					item,
					isSelected,
				})
			: truncateToWidth(displayValue, maxWidth, "");

		return truncateToWidth(truncatedValue, maxWidth, "");
	}

	private getDisplayValue(item: SelectItem): string {
		return item.label || item.value;
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
