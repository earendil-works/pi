import type { Component } from "./tui.ts";

/** Semantic role of one rendered transcript block. */
export type TranscriptBlockKind = "user" | "assistant" | "tool";

/** Stable, application-owned identity for a semantic transcript block. */
export interface TranscriptTarget {
	/** Unique within the current transcript. */
	readonly id: string;
	readonly kind: TranscriptBlockKind;
	/** Application data associated with this target. */
	readonly metadata?: unknown;
}

/** Marks a component as one semantic transcript block. */
export const TRANSCRIPT_BLOCK = Symbol.for("@earendil-works/pi-tui/transcript-block");

export interface TranscriptBlockComponent extends Component {
	[TRANSCRIPT_BLOCK](): TranscriptTarget;
}

/** Exact semantic extent in transcript content-row coordinates. */
export interface TranscriptSemanticBlock {
	readonly target: TranscriptTarget;
	readonly startRow: number;
	readonly endRow: number;
}

/** Transcript-specific semantic queries implemented by windowed content providers. */
export interface TranscriptSemantics {
	blocks(startRow: number, endRow: number): readonly TranscriptSemanticBlock[];
	blockAt(row: number): TranscriptSemanticBlock | undefined;
	latestResponse(): TranscriptSemanticBlock | undefined;
	find(target: TranscriptTarget): TranscriptSemanticBlock | undefined;
}

export const TRANSCRIPT_SEMANTICS = Symbol.for("@earendil-works/pi-tui/transcript-semantics");

export interface TranscriptSemanticsComponent extends Component {
	[TRANSCRIPT_SEMANTICS](): TranscriptSemantics;
}

export function getTranscriptTarget(component: Component): TranscriptTarget | undefined {
	const candidate = component as Partial<TranscriptBlockComponent>;
	const getTarget = candidate[TRANSCRIPT_BLOCK];
	if (typeof getTarget !== "function") return undefined;
	const target = getTarget.call(component);
	if (
		target === null ||
		typeof target !== "object" ||
		typeof target.id !== "string" ||
		(target.kind !== "user" && target.kind !== "assistant" && target.kind !== "tool")
	) {
		return undefined;
	}
	return target;
}

export function getTranscriptSemantics(component: Component): TranscriptSemantics | undefined {
	const candidate = component as Partial<TranscriptSemanticsComponent>;
	const getSemantics = candidate[TRANSCRIPT_SEMANTICS];
	return typeof getSemantics === "function" ? getSemantics.call(component) : undefined;
}
