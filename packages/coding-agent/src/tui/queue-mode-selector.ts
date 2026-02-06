import { Container, type SelectItem, SelectList } from "@kennyfrc/mu-tui";
import { getSelectListTheme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

/**
 * Component that renders a queue mode selector with borders
 */
export class QueueModeSelectorComponent extends Container {
	private selectList: SelectList;

	constructor(
		currentMode: "all" | "one-at-a-time" | "steer",
		onSelect: (mode: "all" | "one-at-a-time" | "steer") => void,
		onCancel: () => void,
	) {
		super();

		const queueModes: SelectItem[] = [
			{
				value: "one-at-a-time",
				label: "one-at-a-time",
				description: "Process queued messages one by one (recommended)",
			},
			{
				value: "steer",
				label: "steer",
				description: "Inject queued message after tool calls (between tool results and the continuation response)",
			},
			{ value: "all", label: "all", description: "Process all queued messages at once" },
		];

		// Add top border
		this.addChild(new DynamicBorder());

		// Create selector
		this.selectList = new SelectList(queueModes, 3, getSelectListTheme());

		// Preselect current mode
		const currentIndex = queueModes.findIndex((item) => item.value === currentMode);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value as "all" | "one-at-a-time" | "steer");
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
