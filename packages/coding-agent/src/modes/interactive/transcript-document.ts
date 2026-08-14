import {
	type Component,
	Container,
	getTranscriptTarget,
	TRANSCRIPT_SEMANTICS,
	type TranscriptSemanticBlock,
	type TranscriptSemantics,
	type TranscriptTarget,
	WINDOWED_SCROLL_CONTENT,
	type WindowedScrollContentRequest,
	type WindowedScrollWindow,
} from "@earendil-works/pi-tui";
import { TranscriptHeightIndex } from "./transcript-height-index.ts";

const MAX_CACHE_ENTRIES = 512;
const MAX_CACHE_ROWS = 2_000;
const MAX_CACHE_CODE_UNITS = 1_000_000;
const MAX_OVERSIZED_CACHE_ENTRIES = 8;
const MAX_OVERSIZED_CACHE_ROWS = 100_000;
const MAX_OVERSIZED_CACHE_CODE_UNITS = 8_000_000;

interface DisposableComponent extends Component {
	dispose(): void;
}

function isDisposable(component: Component): component is DisposableComponent {
	return "dispose" in component && typeof component.dispose === "function";
}

export interface TranscriptBlockDefinition {
	readonly id: string;
	readonly revision?: number | string;
	readonly target?: TranscriptTarget;
	/** Opaque extension components may opt out of component eviction. */
	readonly persistent?: boolean;
	create(): Component;
}

type TranscriptContainerMutation =
	| { type: "append"; component: Component }
	| { type: "insert" | "remove" | "replace" | "clear" };

interface TranscriptContainerObserver {
	structureChanged(container: TranscriptContainer, mutation: TranscriptContainerMutation): void;
	dirty(component: Component): void;
	invalidated(): void;
}

/** Mutable live-tail container that reports structural and height-affecting changes. */
export class TranscriptContainer extends Container {
	private observer: TranscriptContainerObserver | undefined;

	setObserver(observer: TranscriptContainerObserver): void {
		this.observer = observer;
	}

	override addChild(component: Component): void {
		super.addChild(component);
		this.observer?.structureChanged(this, { type: "append", component });
	}

	insertChild(index: number, component: Component): void {
		const safeIndex = Math.max(0, Math.min(this.children.length, Math.trunc(index)));
		this.children.splice(safeIndex, 0, component);
		this.observer?.structureChanged(this, { type: "insert" });
	}

	replaceChild(previous: Component, next: Component): boolean {
		const index = this.children.indexOf(previous);
		if (index < 0) return false;
		this.children[index] = next;
		this.observer?.structureChanged(this, { type: "replace" });
		return true;
	}

	override removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index < 0) return;
		this.children.splice(index, 1);
		this.observer?.structureChanged(this, { type: "remove" });
	}

	override clear(): void {
		if (this.children.length === 0) return;
		super.clear();
		this.observer?.structureChanged(this, { type: "clear" });
	}

	markDirty(component: Component): void {
		if (this.children.includes(component)) this.observer?.dirty(component);
	}

	override invalidate(): void {
		super.invalidate();
		this.observer?.invalidated();
	}
}

interface TranscriptRecord {
	id: string;
	revision: number | string;
	target?: TranscriptTarget;
	persistent: boolean;
	component?: Component;
	create?: () => Component;
}

interface RenderCacheEntry {
	revision: number | string;
	lines: readonly string[];
	rows: number;
	codeUnits: number;
}

interface TranscriptAnchor {
	id: string;
	ordinal: number;
	rowWithinBlock: number;
}

/**
 * Exact, source-backed transcript document.
 *
 * History definitions retain semantic session data and factories, never mounted UI
 * trees. Only the exact viewport and explicitly persistent live/extension blocks
 * remain mounted. All indexes and rendered lines are disposable projections.
 */
export class TranscriptDocument implements Component {
	private readonly header: TranscriptContainer;
	private readonly resources: TranscriptContainer;
	private readonly live: TranscriptContainer;
	private readonly requestRender: () => void;
	private history: readonly TranscriptBlockDefinition[] = [];
	private historyIds = new Set<string>();
	private records: TranscriptRecord[] = [];
	private readonly generatedIds = new WeakMap<Component, string>();
	private nextGeneratedId = 0;
	private readonly recordByComponent = new Map<Component, TranscriptRecord>();
	private readonly recordIndexById = new Map<string, number>();
	private heightIndex = new TranscriptHeightIndex();
	private heights: number[] = [];
	private measuredWidth: number | undefined;
	private structureDirty = true;
	private invalidated = true;
	private dirtyRecordIds = new Set<string>();
	private dirtyComponents = new Set<Component>();
	private pendingLiveAppends: Component[] = [];
	private suppressStructureObservation = false;
	private renderCache = new Map<string, RenderCacheEntry>();
	private oversizedRenderCache = new Map<string, RenderCacheEntry>();
	private oversizedCacheRows = 0;
	private oversizedCacheCodeUnits = 0;
	private cacheRows = 0;
	private cacheCodeUnits = 0;
	private fullRenderCache: { width: number; lines: readonly string[] } | undefined;
	private eagerMode = false;
	private contentRevision = 0;
	private readonly semantics: TranscriptSemantics;

	constructor(options: {
		header: TranscriptContainer;
		resources: TranscriptContainer;
		live: TranscriptContainer;
		requestRender: () => void;
	}) {
		this.header = options.header;
		this.resources = options.resources;
		this.live = options.live;
		this.requestRender = options.requestRender;
		const observer: TranscriptContainerObserver = {
			structureChanged: (container, mutation) => this.onStructureChanged(container, mutation),
			dirty: (component) => this.onComponentDirty(component),
			invalidated: () => this.invalidateDerivedState(false),
		};
		this.header.setObserver(observer);
		this.resources.setObserver(observer);
		this.live.setObserver(observer);
		this.semantics = {
			blocks: (startRow, endRow) => this.semanticBlocks(startRow, endRow),
			blockAt: (row) => this.semanticBlockAt(row),
			latestResponse: () => this.latestResponse(),
			find: (target) => this.findSemanticBlock(target),
		};
	}

	setHistory(definitions: readonly TranscriptBlockDefinition[]): void {
		const ids = new Set<string>();
		for (const definition of definitions) {
			if (!definition.id) throw new Error("Transcript block IDs must not be empty");
			if (ids.has(definition.id)) throw new Error(`Duplicate transcript block ID: ${definition.id}`);
			ids.add(definition.id);
		}
		this.history = [...definitions];
		this.historyIds = ids;
		this.contentRevision += 1;
		this.structureDirty = true;
		this.pendingLiveAppends = [];
		this.fullRenderCache = undefined;
	}

	/** Append canonical history and discard its provisional live rendering in one suffix transaction. */
	appendHistoryAndClearLive(definitions: readonly TranscriptBlockDefinition[]): boolean {
		const appendedIds = new Set<string>();
		for (const definition of definitions) {
			if (!definition.id) throw new Error("Transcript block IDs must not be empty");
			if (this.historyIds.has(definition.id) || appendedIds.has(definition.id)) {
				throw new Error(`Duplicate transcript block ID: ${definition.id}`);
			}
			appendedIds.add(definition.id);
		}

		const prefixLength = this.header.children.length + this.resources.children.length + this.history.length;
		const canReusePrefix =
			!this.structureDirty &&
			!this.invalidated &&
			this.measuredWidth !== undefined &&
			prefixLength <= this.records.length;
		this.history = [...this.history, ...definitions];
		for (const id of appendedIds) this.historyIds.add(id);
		this.contentRevision += 1;
		this.fullRenderCache = undefined;

		this.suppressStructureObservation = true;
		try {
			this.live.clear();
		} finally {
			this.suppressStructureObservation = false;
		}
		this.pendingLiveAppends = [];

		if (!canReusePrefix) {
			this.structureDirty = true;
			return false;
		}

		const removed = this.records.splice(prefixLength);
		this.heights.length = prefixLength;
		this.heightIndex.truncate(prefixLength);
		for (const record of removed) {
			if (record.component) this.recordByComponent.delete(record.component);
			this.recordIndexById.delete(record.id);
			this.dirtyRecordIds.delete(record.id);
			this.removeCache(record.id);
		}
		for (const component of this.dirtyComponents) {
			if (!this.recordByComponent.has(component)) this.dirtyComponents.delete(component);
		}

		const width = this.measuredWidth!;
		for (const definition of definitions) {
			const record = this.historyRecord(definition);
			const height = this.renderRecord(record, width).length;
			const index = this.records.length;
			this.records.push(record);
			this.heights.push(height);
			this.heightIndex.append(height);
			this.recordIndexById.set(record.id, index);
			if (record.component) this.recordByComponent.set(record.component, record);
		}
		this.structureDirty = false;
		return true;
	}

	clearLive(): void {
		this.appendHistoryAndClearLive([]);
	}

	/** Retain history component trees only while terminal-owned scrollback needs full rendering. */
	setEagerMode(enabled: boolean): void {
		if (enabled === this.eagerMode) return;
		this.eagerMode = enabled;
		this.fullRenderCache = undefined;
		if (enabled) return;
		for (const record of this.records) {
			if (!record.create || record.persistent || !record.component) continue;
			if (isDisposable(record.component)) record.component.dispose();
			this.recordByComponent.delete(record.component);
			record.component = undefined;
		}
	}

	private onStructureChanged(container: TranscriptContainer, mutation: TranscriptContainerMutation): void {
		if (this.suppressStructureObservation) return;
		this.contentRevision += 1;
		this.fullRenderCache = undefined;
		if (
			container === this.live &&
			mutation.type === "append" &&
			!this.structureDirty &&
			this.measuredWidth !== undefined
		) {
			this.pendingLiveAppends.push(mutation.component);
			return;
		}
		this.structureDirty = true;
		this.pendingLiveAppends = [];
	}

	private onComponentDirty(component: Component): void {
		this.contentRevision += 1;
		this.fullRenderCache = undefined;
		const record = this.recordByComponent.get(component);
		if (record) {
			record.revision =
				typeof record.revision === "number"
					? record.revision + 1
					: `${record.revision}:dirty:${this.contentRevision}`;
			this.dirtyRecordIds.add(record.id);
			this.removeCache(record.id);
		} else {
			this.dirtyComponents.add(component);
		}
	}

	private invalidateDerivedState(invalidateChildren: boolean): void {
		this.contentRevision += 1;
		if (invalidateChildren) {
			this.header.invalidate();
			this.resources.invalidate();
			this.live.invalidate();
			for (const record of this.records) {
				if (record.create && record.component) record.component.invalidate();
			}
		}
		this.invalidated = true;
		this.fullRenderCache = undefined;
		this.clearRenderCache();
	}

	invalidate(): void {
		this.invalidateDerivedState(true);
	}

	private generatedId(component: Component, source: string): string {
		let id = this.generatedIds.get(component);
		if (!id) {
			id = `${source}:component:${this.nextGeneratedId++}`;
			this.generatedIds.set(component, id);
		}
		return id;
	}

	private sourceRecord(component: Component, source: string, previous?: TranscriptRecord): TranscriptRecord {
		return {
			id: this.generatedId(component, source),
			revision: previous?.revision ?? 0,
			target: getTranscriptTarget(component),
			persistent: true,
			component,
		};
	}

	private historyRecord(definition: TranscriptBlockDefinition, previous?: TranscriptRecord): TranscriptRecord {
		const requestedRevision = definition.revision ?? 0;
		const reusable = previous?.create !== undefined && previous.revision === requestedRevision;
		if (!reusable && previous?.component && isDisposable(previous.component)) previous.component.dispose();
		return {
			id: definition.id,
			revision: requestedRevision,
			target: definition.target,
			persistent: definition.persistent ?? false,
			...(reusable && previous?.component ? { component: previous.component } : {}),
			create: definition.create,
		};
	}

	private rebuildRecords(): void {
		const previousById = new Map(this.records.map((record) => [record.id, record] as const));
		const next: TranscriptRecord[] = [];
		for (const component of this.header.children) {
			const id = this.generatedId(component, "header");
			next.push(this.sourceRecord(component, "header", previousById.get(id)));
		}
		for (const component of this.resources.children) {
			const id = this.generatedId(component, "resources");
			next.push(this.sourceRecord(component, "resources", previousById.get(id)));
		}
		for (const definition of this.history) {
			next.push(this.historyRecord(definition, previousById.get(definition.id)));
		}
		for (const component of this.live.children) {
			const id = this.generatedId(component, "live");
			next.push(this.sourceRecord(component, "live", previousById.get(id)));
		}

		const ids = new Set<string>();
		for (const record of next) {
			if (ids.has(record.id)) throw new Error(`Duplicate active transcript block ID: ${record.id}`);
			ids.add(record.id);
		}
		for (const old of this.records) {
			if (!ids.has(old.id) && old.create && old.component && isDisposable(old.component)) old.component.dispose();
		}
		this.records = next;
		this.rebuildRecordMaps();
		this.structureDirty = false;
		this.pendingLiveAppends = [];
	}

	private rebuildRecordMaps(): void {
		this.recordByComponent.clear();
		this.recordIndexById.clear();
		for (let index = 0; index < this.records.length; index++) {
			const record = this.records[index];
			if (!record) continue;
			this.recordIndexById.set(record.id, index);
			if (record.component) this.recordByComponent.set(record.component, record);
		}
	}

	private appendPendingLiveRecords(width: number): void {
		if (this.pendingLiveAppends.length === 0) return;
		for (const component of this.pendingLiveAppends) {
			const record = this.sourceRecord(component, "live");
			if (this.recordIndexById.has(record.id)) continue;
			const lines = this.renderRecord(record, width);
			const index = this.records.length;
			this.records.push(record);
			this.heights.push(lines.length);
			this.heightIndex.append(lines.length);
			this.recordIndexById.set(record.id, index);
			this.recordByComponent.set(component, record);
		}
		this.pendingLiveAppends = [];
	}

	private captureAnchor(scrollTop: number, followingEnd: boolean): TranscriptAnchor | undefined {
		if (followingEnd || this.records.length === 0 || this.heightIndex.total === 0) return undefined;
		const row = Math.max(0, Math.min(this.heightIndex.total - 1, Math.trunc(scrollTop)));
		const ordinal = this.heightIndex.blockAtRow(row);
		const record = this.records[ordinal];
		if (!record) return undefined;
		return {
			id: record.id,
			ordinal,
			rowWithinBlock: row - this.heightIndex.prefixSum(ordinal),
		};
	}

	private restoreAnchor(anchor: TranscriptAnchor | undefined): number | undefined {
		if (!anchor || this.records.length === 0 || this.heightIndex.total === 0) return undefined;
		let ordinal = this.recordIndexById.get(anchor.id);
		if (ordinal === undefined) ordinal = Math.min(anchor.ordinal, this.records.length - 1);
		while (ordinal < this.records.length && (this.heights[ordinal] ?? 0) === 0) ordinal += 1;
		if (ordinal >= this.records.length) {
			ordinal = Math.min(anchor.ordinal, this.records.length - 1);
			while (ordinal > 0 && (this.heights[ordinal] ?? 0) === 0) ordinal -= 1;
		}
		const height = this.heights[ordinal] ?? 0;
		if (height === 0) return 0;
		return this.heightIndex.prefixSum(ordinal) + Math.min(anchor.rowWithinBlock, height - 1);
	}

	private prepare(request: WindowedScrollContentRequest): number | undefined {
		const width = Math.max(1, Math.trunc(request.width));
		const anchor = this.captureAnchor(request.scrollTop, request.followingEnd);
		if (this.measuredWidth !== undefined && this.measuredWidth !== width) {
			this.contentRevision += 1;
			this.clearRenderCache();
		}
		if (!this.structureDirty) this.appendPendingLiveRecords(width);

		if (this.structureDirty) {
			const previousHeights = new Map<string, { revision: number | string; height: number }>();
			for (let index = 0; index < this.records.length; index++) {
				const record = this.records[index];
				if (record) previousHeights.set(record.id, { revision: record.revision, height: this.heights[index] ?? 0 });
			}
			this.rebuildRecords();
			const nextHeights = this.records.map((record) => {
				const previous = previousHeights.get(record.id);
				if (!this.invalidated && this.measuredWidth === width && previous?.revision === record.revision) {
					return previous.height;
				}
				return this.renderRecord(record, width).length;
			});
			this.heightIndex = new TranscriptHeightIndex(nextHeights);
			this.heights = nextHeights;
			this.measuredWidth = width;
			this.dirtyRecordIds.clear();
			this.dirtyComponents.clear();
			this.invalidated = false;
		} else if (this.invalidated || this.measuredWidth !== width) {
			this.clearRenderCache();
			const nextHeights = this.records.map((record) => this.renderRecord(record, width).length);
			this.heightIndex = new TranscriptHeightIndex(nextHeights);
			this.heights = nextHeights;
			this.measuredWidth = width;
			this.dirtyRecordIds.clear();
			this.dirtyComponents.clear();
			this.invalidated = false;
		} else if (this.dirtyRecordIds.size > 0 || this.dirtyComponents.size > 0) {
			for (const component of this.dirtyComponents) {
				const record = this.recordByComponent.get(component);
				if (record) {
					record.revision =
						typeof record.revision === "number"
							? record.revision + 1
							: `${record.revision}:dirty:${this.contentRevision}`;
					this.dirtyRecordIds.add(record.id);
				}
			}
			this.dirtyComponents.clear();
			const updates: Array<{ index: number; height: number }> = [];
			for (const id of this.dirtyRecordIds) {
				const index = this.recordIndexById.get(id);
				const record = index === undefined ? undefined : this.records[index];
				if (index === undefined || !record) continue;
				const height = this.renderRecord(record, width).length;
				updates.push({ index, height });
			}
			this.heightIndex.updateMany(updates);
			for (const update of updates) this.heights[update.index] = update.height;
			this.dirtyRecordIds.clear();
		}
		return this.restoreAnchor(anchor);
	}

	private renderFailure(record: TranscriptRecord, error: unknown): readonly string[] {
		const message = error instanceof Error ? error.message : String(error);
		return [`Transcript block ${record.id} failed to render: ${message}`];
	}

	private renderRecord(record: TranscriptRecord, width: number): readonly string[] {
		const cached = record.persistent
			? undefined
			: (this.renderCache.get(record.id) ?? this.oversizedRenderCache.get(record.id));
		if (cached?.revision === record.revision) {
			const cache = this.renderCache.has(record.id) ? this.renderCache : this.oversizedRenderCache;
			cache.delete(record.id);
			cache.set(record.id, cached);
			return cached.lines;
		}
		let component = record.component;
		const retainComponent = record.persistent || this.eagerMode;
		try {
			component ??= record.create?.();
			if (!component) throw new Error("Transcript block factory returned no component");
			if (retainComponent && !record.component) {
				record.component = component;
				this.recordByComponent.set(component, record);
			}
			const rendered = component.render(width);
			if (!Array.isArray(rendered) || rendered.some((line) => typeof line !== "string")) {
				throw new TypeError("Component.render() must return string[]");
			}
			const lines = [...rendered];
			this.storeCache(record, lines);
			return lines;
		} catch (error) {
			const lines = this.renderFailure(record, error);
			this.storeCache(record, lines);
			return lines;
		} finally {
			if (component && !retainComponent && isDisposable(component)) component.dispose();
		}
	}

	private storeCache(record: TranscriptRecord, lines: readonly string[]): void {
		this.removeCache(record.id);
		const rows = lines.length;
		const codeUnits = lines.reduce((total, line) => total + line.length, 0);
		const entry: RenderCacheEntry = { revision: record.revision, lines, rows, codeUnits };
		if (rows > MAX_CACHE_ROWS || codeUnits > MAX_CACHE_CODE_UNITS) {
			if (rows <= MAX_OVERSIZED_CACHE_ROWS && codeUnits <= MAX_OVERSIZED_CACHE_CODE_UNITS) {
				this.oversizedRenderCache.set(record.id, entry);
				this.oversizedCacheRows += rows;
				this.oversizedCacheCodeUnits += codeUnits;
				while (
					this.oversizedRenderCache.size > MAX_OVERSIZED_CACHE_ENTRIES ||
					this.oversizedCacheRows > MAX_OVERSIZED_CACHE_ROWS ||
					this.oversizedCacheCodeUnits > MAX_OVERSIZED_CACHE_CODE_UNITS
				) {
					const oldestId = this.oversizedRenderCache.keys().next().value as string | undefined;
					if (oldestId === undefined) break;
					this.removeCache(oldestId);
				}
			}
			return;
		}
		this.renderCache.set(record.id, entry);
		this.cacheRows += rows;
		this.cacheCodeUnits += codeUnits;
		while (
			this.renderCache.size > MAX_CACHE_ENTRIES ||
			this.cacheRows > MAX_CACHE_ROWS ||
			this.cacheCodeUnits > MAX_CACHE_CODE_UNITS
		) {
			const oldestId = this.renderCache.keys().next().value as string | undefined;
			if (oldestId === undefined) break;
			this.removeCache(oldestId);
		}
	}

	private removeCache(id: string): void {
		const oversized = this.oversizedRenderCache.get(id);
		if (oversized) {
			this.oversizedRenderCache.delete(id);
			this.oversizedCacheRows -= oversized.rows;
			this.oversizedCacheCodeUnits -= oversized.codeUnits;
		}
		const entry = this.renderCache.get(id);
		if (!entry) return;
		this.renderCache.delete(id);
		this.cacheRows -= entry.rows;
		this.cacheCodeUnits -= entry.codeUnits;
	}

	private clearRenderCache(): void {
		this.renderCache.clear();
		this.oversizedRenderCache.clear();
		this.oversizedCacheRows = 0;
		this.oversizedCacheCodeUnits = 0;
		this.cacheRows = 0;
		this.cacheCodeUnits = 0;
	}

	private exactLines(record: TranscriptRecord, expectedHeight: number, width: number): readonly string[] {
		const lines = this.renderRecord(record, width);
		if (lines.length === expectedHeight) return lines;
		this.contentRevision += 1;
		this.dirtyRecordIds.add(record.id);
		this.removeCache(record.id);
		this.requestRender();
		if (lines.length > expectedHeight) return lines.slice(0, expectedHeight);
		return [...lines, ...Array.from({ length: expectedHeight - lines.length }, () => "")];
	}

	private renderWindow(width: number, startRow: number, rowCount: number): WindowedScrollWindow {
		if (rowCount <= 0 || this.heightIndex.total === 0) return { startRow, lines: [] };
		let blockIndex = this.heightIndex.blockAtRow(startRow);
		if (blockIndex >= this.records.length) return { startRow: this.heightIndex.total, lines: [] };
		const requestedEnd = Math.min(this.heightIndex.total, startRow + rowCount);
		const lines: string[] = [];
		let documentRow = this.heightIndex.prefixSum(blockIndex);
		while (blockIndex < this.records.length && documentRow < requestedEnd) {
			const record = this.records[blockIndex];
			const height = this.heights[blockIndex] ?? 0;
			if (record && height > 0) {
				const blockLines = this.exactLines(record, height, width);
				const from = Math.max(0, startRow - documentRow);
				const to = Math.min(height, requestedEnd - documentRow);
				lines.push(...blockLines.slice(from, to));
			}
			documentRow += height;
			blockIndex += 1;
		}
		return { startRow, lines };
	}

	private lineAt(width: number, row: number): string | undefined {
		if (!Number.isSafeInteger(row) || row < 0 || row >= this.heightIndex.total) return undefined;
		const blockIndex = this.heightIndex.blockAtRow(row);
		const record = this.records[blockIndex];
		const height = this.heights[blockIndex] ?? 0;
		if (!record || height === 0) return undefined;
		const line = row - this.heightIndex.prefixSum(blockIndex);
		return this.exactLines(record, height, width)[line];
	}

	[WINDOWED_SCROLL_CONTENT](request: WindowedScrollContentRequest) {
		const width = Math.max(1, Math.trunc(request.width));
		const anchorScrollTop = this.prepare({ ...request, width });
		return {
			contentHeight: this.heightIndex.total,
			revision: this.contentRevision,
			...(anchorScrollTop === undefined ? {} : { anchorScrollTop }),
			renderWindow: (startRow: number, rowCount: number) => this.renderWindow(width, startRow, rowCount),
			lineAt: (row: number) => this.lineAt(width, row),
		};
	}

	[TRANSCRIPT_SEMANTICS](): TranscriptSemantics {
		return this.semantics;
	}

	private semanticBlock(index: number): TranscriptSemanticBlock | undefined {
		const record = this.records[index];
		const target = record?.target;
		if (!record || !target) return undefined;
		return {
			target,
			startRow: this.heightIndex.prefixSum(index),
			endRow: this.heightIndex.prefixSum(index + 1),
		};
	}

	private semanticBlocks(startRow: number, endRow: number): readonly TranscriptSemanticBlock[] {
		if (endRow <= startRow || this.heightIndex.total === 0) return [];
		const blocks: TranscriptSemanticBlock[] = [];
		let index = this.heightIndex.blockAtRow(Math.max(0, startRow));
		while (index < this.records.length && this.heightIndex.prefixSum(index) < endRow) {
			const block = this.semanticBlock(index);
			if (block && block.endRow > startRow) blocks.push(block);
			index += 1;
		}
		return blocks;
	}

	private semanticBlockAt(row: number): TranscriptSemanticBlock | undefined {
		if (!Number.isSafeInteger(row) || row < 0 || row >= this.heightIndex.total) return undefined;
		return this.semanticBlock(this.heightIndex.blockAtRow(row));
	}

	private latestResponse(): TranscriptSemanticBlock | undefined {
		let latestUser = -1;
		for (let index = this.records.length - 1; index >= 0; index--) {
			if (this.records[index]?.target?.kind === "user") {
				latestUser = index;
				break;
			}
		}
		for (let index = latestUser + 1; index < this.records.length; index++) {
			if (this.records[index]?.target?.kind === "assistant") return this.semanticBlock(index);
		}
		return undefined;
	}

	private findSemanticBlock(target: TranscriptTarget): TranscriptSemanticBlock | undefined {
		const index = this.records.findIndex(
			(record) => record.target?.id === target.id && record.target.kind === target.kind,
		);
		return index < 0 ? undefined : this.semanticBlock(index);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.trunc(width));
		if (this.fullRenderCache?.width === safeWidth) return [...this.fullRenderCache.lines];
		this.prepare({ width: safeWidth, scrollTop: 0, viewportHeight: 0, followingEnd: false });
		const lines: string[] = [];
		for (let index = 0; index < this.records.length; index++) {
			const record = this.records[index];
			if (!record) continue;
			lines.push(...this.exactLines(record, this.heights[index] ?? 0, safeWidth));
		}
		const codeUnits = lines.reduce((total, line) => total + line.length, 0);
		if (lines.length <= MAX_CACHE_ROWS && codeUnits <= MAX_CACHE_CODE_UNITS) {
			this.fullRenderCache = { width: safeWidth, lines };
		}
		return [...lines];
	}
}
