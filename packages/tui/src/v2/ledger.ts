import type { StyledLine } from "./styles.ts";

export type BlockId = string;
export type BlockState = "open" | "final";

export interface BlockRenderer<Model, Theme> {
	render(model: Model, width: number, theme: Theme): StyledLine[];
}

export interface StableModel<Model> {
	readonly model: Model;
}

export interface CommitFrontier<Model> {
	stableModel(model: Model, final: boolean): StableModel<Model> | undefined;
}

export interface LedgerBlockHandle<Model> {
	readonly id: BlockId;
	readonly state: BlockState;
	update(model: Model): void;
	finalize(model?: Model): void;
}

export interface LedgerCommit {
	readonly blockId: BlockId;
	readonly startLine: number;
	readonly lines: StyledLine[];
	readonly final: boolean;
}

export interface CommittedSegment {
	readonly blockId: BlockId;
	readonly lineCount: number;
}

export interface LedgerFrontier {
	readonly blockIndex: number;
	readonly stableLine: number;
}

interface StoredBlock<Theme> {
	readonly id: BlockId;
	state: BlockState;
	committedLineCount: number;
	renderStable(width: number, theme: Theme): StyledLine[] | undefined;
}

export interface AddLedgerBlockOptions<Model, Theme> {
	readonly id: BlockId;
	model: Model;
	readonly renderer: BlockRenderer<Model, Theme>;
	readonly frontier?: CommitFrontier<Model>;
	readonly state?: BlockState;
}

/** Append-only logical transcript store. Normal advancement only touches the current frontier block. */
export class LedgerStore<Theme> {
	private readonly blocks: StoredBlock<Theme>[] = [];
	private readonly blockIds = new Set<BlockId>();
	private readonly segments: CommittedSegment[] = [];
	private frontierBlockIndex = 0;
	private frontierStableLine = 0;

	addBlock<Model>(options: AddLedgerBlockOptions<Model, Theme>): LedgerBlockHandle<Model> {
		if (this.blockIds.has(options.id)) throw new Error(`Duplicate ledger block id: ${options.id}`);
		let model = options.model;
		const block: StoredBlock<Theme> = {
			id: options.id,
			state: options.state ?? "open",
			committedLineCount: 0,
			renderStable: (width, theme) => {
				const stable = options.frontier?.stableModel(model, block.state === "final");
				if (options.frontier && !stable) return undefined;
				if (!options.frontier && block.state !== "final") return undefined;
				return options.renderer.render(stable?.model ?? model, width, theme);
			},
		};
		this.blocks.push(block);
		this.blockIds.add(options.id);
		return {
			id: options.id,
			get state() {
				return block.state;
			},
			update(nextModel) {
				if (block.state === "final") throw new Error(`Cannot update final ledger block: ${block.id}`);
				model = nextModel;
			},
			finalize(nextModel) {
				if (nextModel !== undefined) model = nextModel;
				block.state = "final";
			},
		};
	}

	advance(width: number, theme: Theme): LedgerCommit[] {
		const commits: LedgerCommit[] = [];
		while (this.frontierBlockIndex < this.blocks.length) {
			const block = this.blocks[this.frontierBlockIndex]!;
			const stableLines = block.renderStable(width, theme);
			if (!stableLines) break;
			if (stableLines.length < block.committedLineCount) {
				throw new Error(
					`Ledger frontier retreated for ${block.id}: ${stableLines.length} < ${block.committedLineCount}`,
				);
			}
			const lines = stableLines.slice(block.committedLineCount);
			if (lines.length > 0) {
				commits.push({
					blockId: block.id,
					startLine: block.committedLineCount,
					lines,
					final: block.state === "final",
				});
				this.segments.push({ blockId: block.id, lineCount: lines.length });
				block.committedLineCount = stableLines.length;
			}
			this.frontierStableLine = block.committedLineCount;
			if (block.state !== "final") break;
			this.frontierBlockIndex++;
			this.frontierStableLine = 0;
		}
		return commits;
	}

	get frontier(): LedgerFrontier {
		return { blockIndex: this.frontierBlockIndex, stableLine: this.frontierStableLine };
	}

	get committed(): readonly CommittedSegment[] {
		return this.segments;
	}

	get blockCount(): number {
		return this.blocks.length;
	}
}

interface Fence {
	readonly marker: "`" | "~";
	readonly length: number;
}

/**
 * Returns the byte offset ending at the latest boundary that is safe under the fallback policy:
 * blank-line-separated content and balanced fenced blocks only.
 */
export function conservativeMarkdownStableOffset(text: string): number {
	let offset = 0;
	let stableOffset = 0;
	let fence: Fence | undefined;
	while (offset < text.length) {
		const newline = text.indexOf("\n", offset);
		if (newline === -1) break;
		const lineEnd = newline + 1;
		const line = text.slice(offset, newline).replace(/\r$/, "");
		const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
		if (fence) {
			if (
				fenceMatch &&
				fenceMatch[1]![0] === fence.marker &&
				fenceMatch[1]!.length >= fence.length &&
				fenceMatch[2]!.trim().length === 0
			) {
				fence = undefined;
				stableOffset = lineEnd;
			}
		} else if (fenceMatch) {
			fence = { marker: fenceMatch[1]![0] as "`" | "~", length: fenceMatch[1]!.length };
		} else if (line.trim().length === 0) {
			stableOffset = lineEnd;
		}
		offset = lineEnd;
	}
	return stableOffset;
}

export class ConservativeMarkdownFrontier implements CommitFrontier<string> {
	stableModel(model: string, final: boolean): StableModel<string> | undefined {
		if (final) return { model };
		const stableOffset = conservativeMarkdownStableOffset(model);
		return stableOffset === 0 ? undefined : { model: model.slice(0, stableOffset) };
	}
}

/** Plain-text tool output frontier: every newline-terminated prefix is stable. */
export class CompletedLineFrontier implements CommitFrontier<string> {
	stableModel(model: string, final: boolean): StableModel<string> | undefined {
		if (final) return { model };
		const newline = model.lastIndexOf("\n");
		return newline === -1 ? undefined : { model: model.slice(0, newline + 1) };
	}
}
