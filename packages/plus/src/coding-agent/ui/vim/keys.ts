// Ported (core subset) from pi-vimmode (MIT, (c) 2026 pekochan069, /Users/kangtong/Documents/x/pi-vimmode).
// Hardcoded key tables for the core subset. No configurable keymaps — protected Pi keys
// are always delegated (see PROTECTED_PI_KEYS).

import type { CharSearchKind, MotionName, OperatorName, SearchDirection } from "./types.ts";

export type InsertEntry = "before" | "after" | "lineStart" | "lineEnd" | "openBelow" | "openAbove" | "changeToEnd";

export type NormalAction =
	| { type: "motion"; motion: MotionName }
	| { type: "operator"; operator: OperatorName }
	| { type: "charSearch"; kind: CharSearchKind }
	| { type: "insert"; entry: InsertEntry }
	| { type: "deleteChar" }
	| { type: "substituteChar" }
	| { type: "replaceChar" }
	| { type: "joinLines" }
	| { type: "paste"; after: boolean }
	| { type: "undo" }
	| { type: "redo" }
	| { type: "visual"; linewise: boolean }
	| { type: "search"; direction: SearchDirection }
	| { type: "searchRepeat"; reverse: boolean };

const motion = (motion: MotionName): NormalAction => ({ type: "motion", motion });
const operator = (operator: OperatorName): NormalAction => ({ type: "operator", operator });
const charSearch = (kind: CharSearchKind): NormalAction => ({ type: "charSearch", kind });

export const NORMAL_KEYS: Record<string, NormalAction> = {
	h: motion("left"),
	j: motion("down"),
	k: motion("up"),
	l: motion("right"),
	w: motion("wordForward"),
	b: motion("wordBackward"),
	e: motion("wordEnd"),
	"0": motion("lineStart"),
	$: motion("lineEnd"),
	"^": motion("firstNonBlank"),
	f: charSearch("findForward"),
	F: charSearch("findBackward"),
	t: charSearch("tillForward"),
	T: charSearch("tillBackward"),
	i: { type: "insert", entry: "before" },
	a: { type: "insert", entry: "after" },
	I: { type: "insert", entry: "lineStart" },
	A: { type: "insert", entry: "lineEnd" },
	o: { type: "insert", entry: "openBelow" },
	O: { type: "insert", entry: "openAbove" },
	C: { type: "insert", entry: "changeToEnd" },
	x: { type: "deleteChar" },
	s: { type: "substituteChar" },
	r: { type: "replaceChar" },
	J: { type: "joinLines" },
	p: { type: "paste", after: true },
	P: { type: "paste", after: false },
	u: { type: "undo" },
	"ctrl+r": { type: "redo" },
	v: { type: "visual", linewise: false },
	V: { type: "visual", linewise: true },
	"/": { type: "search", direction: "forward" },
	"?": { type: "search", direction: "backward" },
	n: { type: "searchRepeat", reverse: false },
	N: { type: "searchRepeat", reverse: true },
	d: operator("delete"),
	c: operator("change"),
	y: operator("yank"),
};

/** Keys that stay Pi's even in normal/visual mode (matched with pi-tui matchesKey). */
export const VISUAL_KEYS: Record<string, NormalAction> = {
	h: motion("left"),
	j: motion("down"),
	k: motion("up"),
	l: motion("right"),
	w: motion("wordForward"),
	b: motion("wordBackward"),
	e: motion("wordEnd"),
	"0": motion("lineStart"),
	$: motion("lineEnd"),
	"^": motion("firstNonBlank"),
	f: charSearch("findForward"),
	F: charSearch("findBackward"),
	t: charSearch("tillForward"),
	T: charSearch("tillBackward"),
	i: { type: "insert", entry: "before" },
	a: { type: "insert", entry: "after" },
	x: { type: "deleteChar" },
	J: { type: "joinLines" },
	r: { type: "replaceChar" },
	p: { type: "paste", after: true },
	P: { type: "paste", after: false },
	d: operator("delete"),
	c: operator("change"),
	y: operator("yank"),
	v: { type: "visual", linewise: false },
	V: { type: "visual", linewise: true },
	"/": { type: "search", direction: "forward" },
	"?": { type: "search", direction: "backward" },
	n: { type: "searchRepeat", reverse: false },
	N: { type: "searchRepeat", reverse: true },
};

/**
 * Keys owned by Pi that vim dispatch must never interpret: submit, autocomplete,
 * model cycling, paste image, external editor, copy, exit, interrupt. Esc is handled
 * separately by the engine (autocomplete-cancel vs mode transition vs Pi interrupt).
 */
export const PROTECTED_PI_KEYS: readonly string[] = [
	"enter",
	"tab",
	"shift+tab",
	"shift+enter",
	"ctrl+j",
	"ctrl+l",
	"ctrl+p",
	"ctrl+v",
	"ctrl+g",
	"ctrl+c",
	"ctrl+d",
];
