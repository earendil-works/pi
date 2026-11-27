// The boundary between the Terminals view and what draws a terminal: `TerminalScreen`, a component that gets a
// terminal's bytes in order and hands back what is typed and its size. How a terminal is rendered is pending a
// decision (a terminal emulator on the page); until then `PlainScreen` shows the text with escape sequences dropped,
// sends the keys typed and the text inserted into it (a phone's keyboard, an input method), and its size in cells. A
// renderer replaces it without touching the view.

import { type ComponentType, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { plain } from "./plain.ts";
import styles from "./terminals-view.module.css";

/** What a screen gets: its terminal's bytes, and where typed keys and a new size go (absent: watch only). */
export type TerminalScreenProps = {
	/** Calls `onBytes` with the terminal's output, the backlog first, in order, until the returned stop. */
	readonly subscribe: (onBytes: (bytes: Uint8Array) => void) => () => void;
	readonly onInput?: (data: string) => void;
	readonly onResize?: (columns: number, rows: number) => void;
	/** The screen's label, for assistive technology. */
	readonly label: string;
};

/** A component drawing one terminal. */
export type TerminalScreen = ComponentType<TerminalScreenProps>;

/** How much text `PlainScreen` keeps. */
const KEPT = 200_000;

/**
 * A terminal as plain text: its output with escape sequences dropped; keys typed into it, text a phone's keyboard or an
 * input method inserts, go to `onInput`; its size in cells, measured whenever it changes, to `onResize`.
 */
export function PlainScreen(props: TerminalScreenProps) {
	const [text, setText] = useState("");
	const end = useRef<HTMLTextAreaElement>(null);
	const shown = useRef(text);
	shown.current = text;
	// The view hands new callbacks on every render: read at each use, so the listeners below are set up once.
	const latest = useRef(props);
	latest.current = props;
	const { subscribe } = props;
	const typable = props.onInput !== undefined;
	const sized = props.onResize !== undefined;
	useEffect(() => {
		const decoder = new TextDecoder();
		return subscribe((bytes) => {
			const piece = plain(decoder.decode(bytes, { stream: true }));
			setText((had) => (had + piece).slice(-KEPT));
		});
	}, [subscribe]);
	// The newest output in view after every change of the text.
	useEffect(() => {
		const element = end.current;
		if (element !== null && text !== "") element.scrollTop = element.scrollHeight;
	}, [text]);
	// A phone's keyboard and an input method send no key presses for what they type (Astra, round 5): the text comes as
	// input events, kept out of the screen, which only ever shows the terminal's output.
	useEffect(() => {
		const element = end.current;
		if (element === null || !typable) return;
		const inserted = (event: InputEvent) => {
			const data = insertedData(event);
			// A composition cannot be cancelled: what it composed goes when it ends.
			if (data === undefined || event.isComposing) return;
			event.preventDefault();
			latest.current.onInput?.(data);
		};
		const composed = (event: CompositionEvent) => {
			if (event.data !== "") latest.current.onInput?.(event.data);
			element.value = shown.current;
		};
		element.addEventListener("beforeinput", inserted);
		element.addEventListener("compositionend", composed);
		return () => {
			element.removeEventListener("beforeinput", inserted);
			element.removeEventListener("compositionend", composed);
		};
	}, [typable]);
	// The size in cells, again on every change of the box (a rotation, a pane dragged).
	useEffect(() => {
		const element = end.current;
		if (element === null || !sized) return;
		const measuring = document.createElement("canvas").getContext("2d");
		let last = { columns: 0, rows: 0 };
		const observer = new ResizeObserver(() => {
			const cells = cellsOf(element, measuring);
			if (cells.columns < 1 || cells.rows < 1) return;
			if (cells.columns === last.columns && cells.rows === last.rows) return;
			last = cells;
			latest.current.onResize?.(cells.columns, cells.rows);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [sized]);
	const typed = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		const data = keyData(event);
		if (data === undefined || props.onInput === undefined) return;
		event.preventDefault();
		props.onInput(data);
	};
	return (
		// Editable only where it can be typed into (so a phone shows its keyboard); the text is only ever the output:
		// every insertion is taken out above, and the value is the output on every render.
		<textarea
			aria-label={props.label}
			className={styles.screen}
			data-terminal-screen=""
			onChange={unchanged}
			onKeyDown={typed}
			readOnly={!typable}
			ref={end}
			spellCheck={false}
			autoCapitalize="off"
			autoCorrect="off"
			value={text}
		/>
	);
}

/** A change of the screen's value, which React puts back to the output at once. */
const unchanged = () => undefined;

/** What an input event inserts into a terminal, or `undefined` for one it does not send. */
function insertedData(event: InputEvent): string | undefined {
	switch (event.inputType) {
		case "insertText":
		case "insertReplacementText":
		case "insertFromPaste":
			return event.data ?? event.dataTransfer?.getData("text/plain") ?? undefined;
		case "insertLineBreak":
		case "insertParagraph":
			return "\r";
		case "deleteContentBackward":
			return "\u007f";
		default:
			return undefined;
	}
}

/** How many cells of the screen's font fit in `element`'s content box (`measuring` measures a cell's width). */
function cellsOf(element: HTMLElement, measuring: CanvasRenderingContext2D | null): { columns: number; rows: number } {
	const style = getComputedStyle(element);
	if (measuring !== null) measuring.font = style.font;
	const width = measuring?.measureText("M").width || Number.parseFloat(style.fontSize) * 0.6;
	const height = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
	const inline = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
	const block = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
	return {
		columns: Math.floor((element.clientWidth - inline) / width),
		rows: Math.floor((element.clientHeight - block) / height),
	};
}

/** The keys with no character of their own, as a terminal reads them. */
const KEYS: Readonly<Record<string, string>> = {
	Enter: "\r",
	Backspace: "\u007f",
	Tab: "\t",
	Escape: "\u001b",
	ArrowUp: "\u001b[A",
	ArrowDown: "\u001b[B",
	ArrowRight: "\u001b[C",
	ArrowLeft: "\u001b[D",
	Home: "\u001b[H",
	End: "\u001b[F",
	Delete: "\u001b[3~",
};

/** What a key press types into a terminal, or `undefined` for a key it does not send. */
function keyData(event: KeyboardEvent): string | undefined {
	if (event.ctrlKey && event.key.length === 1) {
		const code = event.key.toUpperCase().charCodeAt(0);
		return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : undefined;
	}
	if (event.metaKey || event.altKey) return undefined;
	if (event.key.length === 1) return event.key;
	return KEYS[event.key];
}
