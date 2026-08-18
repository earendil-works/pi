import { type Component, Text, TruncatedText } from "@earendil-works/pi-tui";

export class DynamicText<T> extends Text {
	private source: T;
	private readonly format: (source: T) => string;

	constructor(source: T, format: (source: T) => string, paddingX = 1, paddingY = 1) {
		super(format(source), paddingX, paddingY);
		this.source = source;
		this.format = format;
	}

	setSource(source: T): void {
		this.source = source;
		this.refresh();
	}

	override invalidate(): void {
		this.refresh();
	}

	private refresh(): void {
		this.setText(this.format(this.source));
	}
}

export class DynamicTruncatedText<T> implements Component {
	private source: T;
	private readonly format: (source: T) => string;
	private readonly paddingX: number;
	private readonly paddingY: number;
	private text: TruncatedText;

	constructor(source: T, format: (source: T) => string, paddingX = 0, paddingY = 0) {
		this.source = source;
		this.format = format;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.text = new TruncatedText(format(source), paddingX, paddingY);
	}

	setSource(source: T): void {
		this.source = source;
		this.refresh();
	}

	invalidate(): void {
		this.refresh();
	}

	render(width: number): string[] {
		return this.text.render(width);
	}

	private refresh(): void {
		this.text = new TruncatedText(this.format(this.source), this.paddingX, this.paddingY);
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
