import { Container, type SelectItem, SelectList, Spacer, Text } from "@kennyfrc/mu-tui";
import { getSelectListTheme, theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

export class SubscriptionSelectorComponent extends Container {
	private selectList: SelectList;

	constructor(title: string, items: SelectItem[], onSelect: (sessionId: string) => void, onCancel: () => void) {
		super();

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold(title), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.selectList = new SelectList(items, Math.min(items.length, 6), getSelectListTheme(), 60);
		this.selectList.onSelect = (item) => {
			onSelect(item.value as string);
		};
		this.selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
