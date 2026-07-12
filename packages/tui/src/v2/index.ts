// Parallel v2 renderer entry point. v1 remains the default; nothing here is loaded unless the
// PI_TUI=v2 / --tui v2 selection picks the v2 host (plan §1).

export {
	cellsToAnsi,
	closeLink,
	hardWrapStyledLine,
	openLink,
	styledLineToAnsi,
	styleParams,
	styleToSgr,
} from "./ansi.ts";
export { ansiToStyledLine, ansiToStyledLines } from "./ansi-parse.ts";
export type {
	BandGeometry,
	BandHost,
	FrameContext,
	PaintRegion,
	Strip,
	StripGeometry,
	StripPolicy,
	StripSlot,
} from "./band.ts";
export { BandLayout } from "./band.ts";
export { ansiTextRenderer, functionRenderer, plainTextRenderer } from "./blocks.ts";
export type { Cell, DamageRun } from "./cell-buffer.ts";
export { CellBuffer, CellRegion, LinkTable } from "./cell-buffer.ts";
export { LedgerCommitQueue } from "./commit-queue.ts";
export type { FrameCallback, FrameClock, FrameRequest } from "./frame-scheduler.ts";
export { FrameScheduler, systemFrameClock } from "./frame-scheduler.ts";
export { type TuiRenderMode, V2TUIHost } from "./host.ts";
export type {
	AddLedgerBlockOptions,
	BlockId,
	BlockRenderer,
	BlockState,
	CommitFrontier,
	CommittedSegment,
	LedgerBlockHandle,
	LedgerCommit,
	LedgerFrontier,
	StableModel,
} from "./ledger.ts";
export {
	CompletedLineFrontier,
	ConservativeMarkdownFrontier,
	conservativeMarkdownStableOffset,
	LedgerStore,
} from "./ledger.ts";
export { LegacyBlockRendererAdapter, LegacyStripAdapter } from "./legacy.ts";
export type {
	PresentBand,
	PresentCaret,
	PresentFrame,
	PresentReset,
	PresentResult,
	SerializedDamageRun,
} from "./presenter.ts";
export { Presenter } from "./presenter.ts";
export type { FocusedCaret, LedgerBandRendererOptions, RendererMetrics } from "./renderer.ts";
export { LedgerBandRenderer } from "./renderer.ts";
export { Signal, type SignalListener } from "./signal.ts";
export type { Span, StyledLine, TerminalColor, TextStyle } from "./styles.ts";
export { DEFAULT_TEXT_STYLE, plainLine, StyleTable } from "./styles.ts";
export type { CaretCell, TextLayout, VisualLine } from "./text-layout.ts";
export { DefaultTextLayout } from "./text-layout.ts";
export type {
	EditOp,
	KillDirection,
	MoveDirection,
	TextChangeSet,
	TextPosition,
	TextRange,
} from "./text-model.ts";
export { TextModel } from "./text-model.ts";
