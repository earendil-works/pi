import { Container, type SelectItem, SelectList, type SelectListLayoutOptions } from "@earendil-works/pi-tui";
import { getSelectListTheme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { formatTokens } from "./footer.ts";

const CONTEXT_SIZE_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

export interface ContextSizeChoice {
	contextWindow: number;
	extended: boolean;
}

/**
 * Component that lets the user choose between a Copilot model's default and extended
 * context window sizes, rendered with the same borders/theme as ThinkingSelectorComponent.
 */
export class ContextSizeSelectorComponent extends Container {
	private selectList: SelectList;

	constructor(
		defaultContextWindow: number,
		extendedContextWindow: number,
		isCurrentlyExtended: boolean,
		onSelect: (choice: ContextSizeChoice) => void,
		onCancel: () => void,
	) {
		super();

		const items: SelectItem[] = [
			{
				value: "default",
				label: `Default (${formatTokens(defaultContextWindow)} context)`,
				description: "Standard context window",
			},
			{
				value: "extended",
				label: `Extended (${formatTokens(extendedContextWindow)} context)`,
				description: "Larger context window for big codebases or long conversations",
			},
		];

		// Add top border
		this.addChild(new DynamicBorder());

		this.selectList = new SelectList(items, items.length, getSelectListTheme(), CONTEXT_SIZE_SELECT_LIST_LAYOUT);

		// Preselect the currently active choice
		const currentIndex = isCurrentlyExtended ? 1 : 0;
		this.selectList.setSelectedIndex(currentIndex);

		this.selectList.onSelect = (item) => {
			onSelect(
				item.value === "extended"
					? { contextWindow: extendedContextWindow, extended: true }
					: { contextWindow: defaultContextWindow, extended: false },
			);
		};

		this.selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.selectList);

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
