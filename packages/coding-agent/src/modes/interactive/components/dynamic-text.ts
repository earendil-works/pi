import { Text } from "@earendil-works/pi-tui";

export class DynamicText<T> extends Text {
	private readonly source: T;
	private readonly format: (source: T) => string;

	constructor(source: T, format: (source: T) => string, paddingX = 1, paddingY = 1) {
		super(format(source), paddingX, paddingY);
		this.source = source;
		this.format = format;
	}

	override invalidate(): void {
		this.refresh();
	}

	private refresh(): void {
		this.setText(this.format(this.source));
	}
}

export class ExpandableText extends Text {
	private expanded: boolean;
	private readonly getCollapsedText: () => string;
	private readonly getExpandedText: () => string;

	constructor(
		getCollapsedText: () => string,
		getExpandedText: () => string,
		expanded = false,
		paddingX = 0,
		paddingY = 0,
	) {
		super(expanded ? getExpandedText() : getCollapsedText(), paddingX, paddingY);
		this.expanded = expanded;
		this.getCollapsedText = getCollapsedText;
		this.getExpandedText = getExpandedText;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.refresh();
	}

	override invalidate(): void {
		this.refresh();
	}

	private refresh(): void {
		this.setText(this.expanded ? this.getExpandedText() : this.getCollapsedText());
	}
}
