// The boundary between the terminal pane and what draws a terminal: `TerminalScreen`, a component that gets a
// terminal's bytes in order and hands back what is typed and its size. How a terminal is rendered is pending a
// decision (a terminal emulator on the page); until then `PlainScreen` shows the text with escape sequences dropped
// and sends the keys typed into it. A renderer replaces it without touching the pane.

import { type ComponentType, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { plain } from "./plain.ts";
import styles from "./terminals-pane.module.css";

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

/** A terminal as plain text: its output with escape sequences dropped; keys typed into it go to `onInput`. */
export function PlainScreen(props: TerminalScreenProps) {
	const [text, setText] = useState("");
	const end = useRef<HTMLTextAreaElement>(null);
	const { subscribe } = props;
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
	const typed = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		const data = keyData(event);
		if (data === undefined || props.onInput === undefined) return;
		event.preventDefault();
		props.onInput(data);
	};
	return (
		// Read only: the keys go to the terminal, which echoes them; the text is only ever its output.
		<textarea
			aria-label={props.label}
			className={styles.screen}
			data-terminal-screen=""
			onKeyDown={typed}
			readOnly
			ref={end}
			spellCheck={false}
			value={text}
		/>
	);
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
