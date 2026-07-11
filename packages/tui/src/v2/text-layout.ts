import { getGraphemeSegmenter, visibleWidth } from "../utils.ts";
import type { TextModel } from "./text-model.ts";

export interface VisualLine {
	readonly text: string;
	readonly startOffset: number;
	readonly endOffset: number;
	readonly width: number;
	readonly hardBreak: boolean;
}

export interface CaretCell {
	readonly row: number;
	readonly column: number;
}

export interface TextLayout {
	wrap(model: TextModel, width: number): VisualLine[];
	caretCell(model: TextModel, width: number): CaretCell;
}

/** Pure hard-wrapping layout over grapheme clusters. */
export class DefaultTextLayout implements TextLayout {
	wrap(model: TextModel, width: number): VisualLine[] {
		const text = model.text();
		const maximumWidth = Math.max(1, Math.trunc(Number.isFinite(width) ? width : 1));
		const lines: VisualLine[] = [];
		let lineText = "";
		let lineWidth = 0;
		let lineStart = 0;
		for (const segment of getGraphemeSegmenter().segment(text)) {
			const cluster = segment.segment;
			const clusterStart = segment.index;
			if (cluster === "\n") {
				lines.push({
					text: lineText,
					startOffset: lineStart,
					endOffset: clusterStart,
					width: lineWidth,
					hardBreak: true,
				});
				lineText = "";
				lineWidth = 0;
				lineStart = clusterStart + cluster.length;
				continue;
			}
			const clusterWidth = visibleWidth(cluster);
			if (lineText.length > 0 && lineWidth + clusterWidth > maximumWidth) {
				lines.push({
					text: lineText,
					startOffset: lineStart,
					endOffset: clusterStart,
					width: lineWidth,
					hardBreak: false,
				});
				lineText = "";
				lineWidth = 0;
				lineStart = clusterStart;
			}
			lineText += cluster;
			lineWidth += clusterWidth;
		}
		lines.push({
			text: lineText,
			startOffset: lineStart,
			endOffset: text.length,
			width: lineWidth,
			hardBreak: false,
		});
		return lines;
	}

	caretCell(model: TextModel, width: number): CaretCell {
		const lines = this.wrap(model, width);
		const offset = model.cursor().offset;
		let row = lines.length - 1;
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index]!;
			const next = lines[index + 1];
			if (
				offset < line.endOffset ||
				(offset === line.endOffset && (line.hardBreak || next?.startOffset !== offset))
			) {
				row = index;
				break;
			}
		}
		const line = lines[row]!;
		const column = visibleWidth(model.text().slice(line.startOffset, Math.max(line.startOffset, offset)));
		return { row, column: Math.min(Math.max(1, Math.trunc(width)), column) };
	}
}
