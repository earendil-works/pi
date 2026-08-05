import type { KeybindingsManager } from "../../../core/keybindings.ts";

export function getPageSelectionIndex(
	keybindings: Pick<KeybindingsManager, "matches">,
	data: string,
	selectedIndex: number,
	itemCount: number,
	pageSize: number,
): number | undefined {
	const direction = keybindings.matches(data, "tui.select.pageUp")
		? -1
		: keybindings.matches(data, "tui.select.pageDown")
			? 1
			: undefined;
	if (direction === undefined) return undefined;
	return Math.max(0, Math.min(itemCount - 1, selectedIndex + direction * pageSize));
}
