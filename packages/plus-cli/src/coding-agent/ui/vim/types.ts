// Ported (core subset) from pi-vimmode (MIT, (c) 2026 pekochan069, /Users/kangtong/Documents/x/pi-vimmode).
// Shared types for the pure modal engine and the CustomEditor adapter.

export type Position = { line: number; col: number };

export type VimMode = "insert" | "normal" | "visual" | "visualLine";

export type VimRegister = { type: "char" | "line"; text: string };

export type EditResult = {
	text: string;
	cursor: Position;
	register?: VimRegister;
	changed: boolean;
};

export type MotionName =
	| "left"
	| "right"
	| "up"
	| "down"
	| "wordForward"
	| "wordBackward"
	| "wordEnd"
	| "wordForwardBig"
	| "wordBackwardBig"
	| "wordEndBig"
	| "lineStart"
	| "lineEnd"
	| "firstNonBlank"
	| "findCharForward"
	| "findCharBackward"
	| "tillCharForward"
	| "tillCharBackward";

export type OperatorName = "delete" | "change" | "yank";

export type CharSearchKind = "findForward" | "findBackward" | "tillForward" | "tillBackward";

export type SearchDirection = "forward" | "backward";

export type ModalState = {
	mode: VimMode;
	/** Accumulated count, 0 = none pending. */
	count: number;
	pendingOperator: OperatorName | undefined;
	/** Count captured when the operator was pressed (multiplies with the motion count). */
	pendingOperatorCount: number;
	/** Awaiting the target character for f/F/t/T (optionally under an operator). */
	pendingCharSearch: { operator: OperatorName | undefined; kind: CharSearchKind } | undefined;
	/** Awaiting the object key (w) after an operator + i/a, e.g. ciw/daw. */
	pendingTextObject: "inner" | "outer" | undefined;
	/** Awaiting the replacement character for r. */
	pendingReplace: boolean;
	/** Fixed end of the visual selection (cursor is the other end). */
	visualAnchor: Position | undefined;
	register: VimRegister | undefined;
	lastSearch: { query: string; direction: SearchDirection } | undefined;
	/** Search query currently being typed at the status border. */
	pendingSearch: { query: string; direction: SearchDirection } | undefined;
};

export type AdapterCommand =
	| "left"
	| "right"
	| "up"
	| "down"
	| "lineStart"
	| "lineEnd"
	| "wordLeft"
	| "wordRight"
	| "undo"
	| "redo";

export type ModalEffect =
	/** Feed raw input through to Pi's editor (delegation). */
	| { type: "delegate"; input: string }
	/** Cursor movement / undo expressed as terminal input Pi's keybindings understand. */
	| { type: "adapterCommand"; command: AdapterCommand }
	/** A pure buffer edit to apply via setText + cursor restore. */
	| { type: "edit"; result: EditResult }
	/** Move the cursor to an absolute position. */
	| { type: "restoreCursor"; position: Position }
	/** No state change; request a re-render only. */
	| { type: "invalidate" };

export type ModalUpdate = { state: ModalState; effects: ModalEffect[] };

export type EditorSnapshot = {
	text: string;
	lines: string[];
	cursor: Position;
	isAutocompleteOpen: boolean;
};
