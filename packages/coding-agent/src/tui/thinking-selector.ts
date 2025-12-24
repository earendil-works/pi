import type { ThinkingLevel } from "@kennyfrc/pi-agent-core";
import { Container, type SelectItem, SelectList } from "@kennyfrc/pi-tui";
import { getSelectListTheme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

/**
 * Component that renders a thinking level selector with borders
 */
export class ThinkingSelectorComponent extends Container {
	private selectList: SelectList;

	constructor(currentLevel: ThinkingLevel, onSelect: (level: ThinkingLevel) => void, onCancel: () => void) {
		super();

		const thinkingLevels: SelectItem[] = [
			{ value: "off", label: "off", description: "No reasoning" },
			{ value: "minimal", label: "minimal", description: "Very brief reasoning (~1k tokens)" },
			{ value: "low", label: "low", description: "Light reasoning (~2k tokens)" },
			{ value: "medium", label: "medium", description: "Moderate reasoning (~8k tokens)" },
			{ value: "high", label: "high", description: "Deep reasoning (~16k tokens)" },
		];

		// Add top border
		this.addChild(new DynamicBorder());

		// Create selector
		this.selectList = new SelectList(thinkingLevels, 5, getSelectListTheme());

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
