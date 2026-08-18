import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Container, type SelectItem, SelectList, type SelectListLayoutOptions, t } from "@earendil-works/pi-tui";
import { getSelectListTheme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const THINKING_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

function getLevelDescriptions(): Record<ThinkingLevel, string> {
	return {
		off: t("codingAgent.ui.settings.thinking.off"),
		minimal: t("codingAgent.ui.settings.thinking.minimal"),
		low: t("codingAgent.ui.settings.thinking.low"),
		medium: t("codingAgent.ui.settings.thinking.medium"),
		high: t("codingAgent.ui.settings.thinking.high"),
		xhigh: t("codingAgent.ui.settings.thinking.xhigh"),
		max: t("codingAgent.ui.settings.thinking.max"),
	};
}

/**
 * Component that renders a thinking level selector with borders
 */
export class ThinkingSelectorComponent extends Container {
	private selectList: SelectList;

	constructor(
		currentLevel: ThinkingLevel,
		availableLevels: ThinkingLevel[],
		onSelect: (level: ThinkingLevel) => void,
		onCancel: () => void,
	) {
		super();

		const levelDescriptions = getLevelDescriptions();
		const thinkingLevels: SelectItem[] = availableLevels.map((level) => ({
			value: level,
			label: level,
			description: levelDescriptions[level],
		}));

		// Add top border
		this.addChild(new DynamicBorder());

		// Create selector
		this.selectList = new SelectList(
			thinkingLevels,
			thinkingLevels.length,
			getSelectListTheme(),
			THINKING_SELECT_LIST_LAYOUT,
		);

		// Preselect current level
		const currentIndex = thinkingLevels.findIndex((item) => item.value === currentLevel);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value as ThinkingLevel);
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
