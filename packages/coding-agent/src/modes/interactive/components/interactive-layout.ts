import { type Component, VStack } from "@earendil-works/pi-tui";

/**
 * Shared chrome parts for interactive regular + fullscreen layouts.
 * Kept pure so tests can compose the same tree InteractiveMode mounts.
 */
export interface InteractiveChromeParts {
	topBar: Component;
	transcriptScrollView: Component;
	document: Component;
	pendingMessages: Component;
	status: Component;
	widgetAbove: Component;
	editor: Component;
	widgetBelow: Component;
	footer: Component;
}

export interface InteractiveLayouts {
	/** Fullscreen root: fixed top bar, growing transcript ScrollView, dock last. */
	fullscreenLayoutRoot: VStack;
	/** Bottom chrome stack shared inside the fullscreen root. */
	dock: VStack;
	/** Regular (main-screen) mount order — no top bar. */
	regularModeMountChildren: Component[];
}

/**
 * Build the interactive layout trees used by InteractiveMode.
 * Fullscreen places the top bar outside the transcript ScrollView as a fixed first row.
 * Regular mode mounts the listed children only (document + dock parts; no top bar).
 */
export function buildInteractiveLayouts(parts: InteractiveChromeParts): InteractiveLayouts {
	const dock = new VStack([
		{ component: parts.pendingMessages, shrink: 1, minSize: 0 },
		{ component: parts.status, shrink: 1, minSize: 0 },
		{ component: parts.widgetAbove, shrink: 1, minSize: 0 },
		{ component: parts.editor, shrink: 1, minSize: 3 },
		{ component: parts.widgetBelow, shrink: 1, minSize: 0 },
		{ component: parts.footer, shrink: 1, minSize: 1 },
	]);

	const fullscreenLayoutRoot = new VStack([
		{ component: parts.topBar, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
		{ component: parts.transcriptScrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);

	const regularModeMountChildren: Component[] = [
		parts.document,
		parts.pendingMessages,
		parts.status,
		parts.widgetAbove,
		parts.editor,
		parts.widgetBelow,
		parts.footer,
	];

	return { fullscreenLayoutRoot, dock, regularModeMountChildren };
}
