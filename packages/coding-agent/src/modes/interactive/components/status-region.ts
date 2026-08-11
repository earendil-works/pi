import { type Component, type ScrollView, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";

interface FixedStatusIndicator extends Component {
	render(width: number): [] | [string];
}

export class TranscriptStatusIndicator implements FixedStatusIndicator {
	private readonly transcript: ScrollView;
	private readonly isEnabled: () => boolean;
	private readonly style: (text: string) => string;

	constructor(transcript: ScrollView, isEnabled: () => boolean, style: (text: string) => string) {
		this.transcript = transcript;
		this.isEnabled = isEnabled;
		this.style = style;
	}

	invalidate(): void {
		// No cached state to invalidate.
	}

	render(width: number): [] | [string] {
		if (!this.isEnabled() || this.transcript.isFollowingEnd) return [];
		return [truncateToWidth(this.style("↓"), width, "")];
	}
}

/** Composes a replaceable activity status with a coexisting fixed status. */
export class StatusRegionComponent implements Component {
	private readonly activityStatus: Component;
	private readonly fixedStatus: FixedStatusIndicator;

	constructor(activityStatus: Component, fixedStatus: FixedStatusIndicator) {
		this.activityStatus = activityStatus;
		this.fixedStatus = fixedStatus;
	}

	invalidate(): void {
		this.activityStatus.invalidate();
		this.fixedStatus.invalidate();
	}

	render(width: number): string[] {
		const activityLines = [...this.activityStatus.render(width)];
		const [fixedStatusLine] = this.fixedStatus.render(width);
		if (fixedStatusLine !== undefined) {
			const contentLine = activityLines.findIndex((line) => stripTerminalSequences(line).trim().length > 0);
			if (contentLine === -1) return [...activityLines, fixedStatusLine];
			activityLines[contentLine] = truncateToWidth(`${fixedStatusLine}${activityLines[contentLine]}`, width, "");
		}

		// Own the separator that historically preceded above-editor widgets, so a
		// fixed status can use it while idle without changing the region's height.
		return [...activityLines, ""];
	}
}
