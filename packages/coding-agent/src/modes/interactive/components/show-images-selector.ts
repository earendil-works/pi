import { Container, type SelectItem, SelectList, type SelectListLayoutOptions, t } from "@earendil-works/pi-tui";
import { getSelectListTheme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const SHOW_IMAGES_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

/**
 * Component that renders a show images selector with borders
 */
export class ShowImagesSelectorComponent extends Container {
	private selectList: SelectList;

	constructor(currentValue: boolean, onSelect: (show: boolean) => void, onCancel: () => void) {
		super();

		const items: SelectItem[] = [
			{
				value: "yes",
				label: t("codingAgent.ui.showImages.yes"),
				description: t("codingAgent.ui.showImages.yesDesc"),
			},
			{ value: "no", label: t("codingAgent.ui.showImages.no"), description: t("codingAgent.ui.showImages.noDesc") },
		];

		// Add top border
		this.addChild(new DynamicBorder());

		// Create selector
		this.selectList = new SelectList(items, 5, getSelectListTheme(), SHOW_IMAGES_SELECT_LIST_LAYOUT);

		// Preselect current value
		this.selectList.setSelectedIndex(currentValue ? 0 : 1);

		this.selectList.onSelect = (item) => {
			onSelect(item.value === "yes");
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
