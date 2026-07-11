import { getGraphemeSegmenter, visibleWidth } from "../utils.ts";
import type { PaintRegion } from "./band.ts";
import { type StyledLine, StyleTable } from "./styles.ts";

export interface Cell {
	readonly cluster: string;
	readonly width: 1 | 2;
	readonly styleId: number;
	readonly linkId: number;
}

export interface DamageRun {
	readonly row: number;
	readonly column: number;
	readonly cells: readonly Cell[];
}

const EMPTY_CELL: Cell = Object.freeze({ cluster: " ", width: 1, styleId: 0, linkId: 0 });
const CONTINUATION_CELL: Cell = Object.freeze({ cluster: "", width: 1, styleId: 0, linkId: 0 });

function integer(value: number): number {
	return Math.trunc(Number.isFinite(value) ? value : 0);
}

function sameCell(left: Cell, right: Cell): boolean {
	return (
		left.cluster === right.cluster &&
		left.width === right.width &&
		left.styleId === right.styleId &&
		left.linkId === right.linkId
	);
}

/** Interns OSC-8 targets. Link id 0 always means no link. */
export class LinkTable {
	private readonly links = [""];
	private readonly ids = new Map<string, number>();

	intern(link: string | undefined): number {
		if (!link) return 0;
		const existing = this.ids.get(link);
		if (existing !== undefined) return existing;
		const id = this.links.length;
		this.links.push(link);
		this.ids.set(link, id);
		return id;
	}

	get(id: number): string | undefined {
		return id === 0 ? undefined : this.links[id];
	}
}

/** A bounded, grapheme-aware cell grid used by the v2 live band. */
export class CellBuffer {
	readonly width: number;
	readonly height: number;
	readonly styles: StyleTable;
	readonly links: LinkTable;
	private readonly cells: Cell[][];

	constructor(width: number, height: number, styles = new StyleTable(), links = new LinkTable()) {
		this.width = Math.max(0, integer(width));
		this.height = Math.max(0, integer(height));
		this.styles = styles;
		this.links = links;
		this.cells = Array.from({ length: this.height }, () => Array.from({ length: this.width }, () => EMPTY_CELL));
	}

	get(row: number, column: number): Cell {
		return this.cells[row]?.[column] ?? EMPTY_CELL;
	}

	region(x: number, y: number, width: number, height: number): CellRegion {
		const left = Math.max(0, integer(x));
		const top = Math.max(0, integer(y));
		return new CellRegion(
			this,
			left,
			top,
			Math.max(0, Math.min(integer(width), this.width - left)),
			Math.max(0, Math.min(integer(height), this.height - top)),
		);
	}

	putText(x: number, y: number, line: StyledLine): void {
		this.region(0, 0, this.width, this.height).putText(x, y, line);
	}

	diff(previous: CellBuffer | undefined): DamageRun[] {
		const changed = Array.from({ length: this.height }, () => Array.from({ length: this.width }, () => false));
		for (let row = 0; row < this.height; row++) {
			for (let column = 0; column < this.width; column++) {
				const current = this.get(row, column);
				const prior = previous?.get(row, column) ?? EMPTY_CELL;
				if (!sameCell(current, prior)) changed[row]![column] = true;
			}
			for (let column = 0; column < this.width; column++) {
				if (!changed[row]![column]) continue;
				const current = this.get(row, column);
				const prior = previous?.get(row, column) ?? EMPTY_CELL;
				if (current.cluster === "" || prior.cluster === "") {
					if (column > 0) changed[row]![column - 1] = true;
				}
				if (current.width === 2 || prior.width === 2) {
					if (column + 1 < this.width) changed[row]![column + 1] = true;
				}
			}
		}

		const runs: DamageRun[] = [];
		for (let row = 0; row < this.height; row++) {
			let column = 0;
			while (column < this.width) {
				while (column < this.width && !changed[row]![column]) column++;
				if (column === this.width) break;
				const start = column;
				while (column < this.width && changed[row]![column]) column++;
				runs.push({ row, column: start, cells: this.cells[row]!.slice(start, column) });
			}
		}
		return runs;
	}

	applyDamage(runs: readonly DamageRun[]): void {
		for (const run of runs) {
			if (run.row < 0 || run.row >= this.height) continue;
			for (let index = 0; index < run.cells.length; index++) {
				const column = run.column + index;
				if (column >= 0 && column < this.width) this.cells[run.row]![column] = run.cells[index]!;
			}
		}
	}

	clone(): CellBuffer {
		const clone = new CellBuffer(this.width, this.height, this.styles, this.links);
		for (let row = 0; row < this.height; row++) clone.cells[row] = this.cells[row]!.slice();
		return clone;
	}

	equals(other: CellBuffer): boolean {
		if (this.width !== other.width || this.height !== other.height) return false;
		for (let row = 0; row < this.height; row++) {
			for (let column = 0; column < this.width; column++) {
				if (!sameCell(this.get(row, column), other.get(row, column))) return false;
			}
		}
		return true;
	}

	writeCell(row: number, column: number, cell: Cell): void {
		if (row < 0 || row >= this.height || column < 0 || column >= this.width) return;
		this.clearGlyph(row, column);
		if (cell.width === 2) {
			if (column + 1 >= this.width) return;
			this.clearGlyph(row, column + 1);
			this.cells[row]![column] = cell;
			this.cells[row]![column + 1] = { ...CONTINUATION_CELL, styleId: cell.styleId, linkId: cell.linkId };
			return;
		}
		this.cells[row]![column] = cell;
	}

	private clearGlyph(row: number, column: number): void {
		const cell = this.get(row, column);
		if (cell.cluster === "" && column > 0 && this.get(row, column - 1).width === 2) {
			this.cells[row]![column - 1] = EMPTY_CELL;
			this.cells[row]![column] = EMPTY_CELL;
			return;
		}
		this.cells[row]![column] = EMPTY_CELL;
		if (cell.width === 2 && column + 1 < this.width) this.cells[row]![column + 1] = EMPTY_CELL;
	}
}

/** A clipped local-coordinate view into a CellBuffer. */
export class CellRegion implements PaintRegion {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	private readonly buffer: CellBuffer;

	constructor(buffer: CellBuffer, x: number, y: number, width: number, height: number) {
		this.buffer = buffer;
		this.x = x;
		this.y = y;
		this.width = width;
		this.height = height;
	}

	putText(x: number, y: number, line: StyledLine): void {
		const localY = integer(y);
		if (localY < 0 || localY >= this.height) return;
		let localX = integer(x);
		for (const span of line) {
			const styleId = this.buffer.styles.intern(span.style);
			const linkId = this.buffer.links.intern(span.link);
			for (const segment of getGraphemeSegmenter().segment(span.text)) {
				const cluster = segment.segment;
				if (cluster === "\n" || cluster === "\r") return;
				if (cluster === "\t") {
					for (let tabColumn = 0; tabColumn < 3; tabColumn++) {
						this.paintCluster(localX, localY, " ", 1, styleId, linkId);
						localX++;
					}
					continue;
				}
				const measured = visibleWidth(cluster);
				if (measured === 0) {
					this.appendZeroWidthCluster(localX, localY, cluster);
					continue;
				}
				const clusterWidth: 1 | 2 = measured >= 2 ? 2 : 1;
				this.paintCluster(localX, localY, cluster, clusterWidth, styleId, linkId);
				localX += clusterWidth;
			}
		}
	}

	private paintCluster(
		localX: number,
		localY: number,
		cluster: string,
		width: 1 | 2,
		styleId: number,
		linkId: number,
	): void {
		if (localX < 0 || localX + width > this.width) return;
		this.buffer.writeCell(this.y + localY, this.x + localX, { cluster, width, styleId, linkId });
	}

	private appendZeroWidthCluster(localX: number, localY: number, cluster: string): void {
		const previousColumn = localX - 1;
		if (previousColumn < 0 || previousColumn >= this.width) return;
		const row = this.y + localY;
		let column = this.x + previousColumn;
		let previous = this.buffer.get(row, column);
		if (previous.cluster === "" && column > this.x) {
			column--;
			previous = this.buffer.get(row, column);
		}
		if (previous.cluster === " " || previous.cluster === "") return;
		this.buffer.writeCell(row, column, { ...previous, cluster: previous.cluster + cluster });
	}
}
