import { Text } from "@earendil-works/pi-tui";

export class DynamicText extends Text {
	private readonly getText: () => string;

	constructor(getText: () => string, paddingX = 1, paddingY = 1) {
		super(getText(), paddingX, paddingY);
		this.getText = getText;
	}

	override invalidate(): void {
		this.setText(this.getText());
	}
}

export class ExpandableText extends DynamicText {
	private readonly state: { expanded: boolean };

	constructor(
		getCollapsedText: () => string,
		getExpandedText: () => string,
		expanded = false,
		paddingX = 0,
		paddingY = 0,
	) {
		const state = { expanded };
		super(() => (state.expanded ? getExpandedText() : getCollapsedText()), paddingX, paddingY);
		this.state = state;
	}

	setExpanded(expanded: boolean): void {
		this.state.expanded = expanded;
		this.invalidate();
	}
}
