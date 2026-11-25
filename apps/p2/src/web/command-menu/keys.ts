// The web's default key table: modifier shortcuts by binding id, starting with the command menu's. A later keybinding
// table (and shortcuts for commands) extends it instead of checking keys in place.
import { APPLE } from "../input-hints.ts";

/** A key pressed with the platform's primary modifier (Cmd on macOS, Ctrl elsewhere) and no other modifier. */
export type KeyChord = { readonly key: string };

/** The default bindings by id. */
export const DEFAULT_KEYS = {
	"p2.commands.open": [{ key: "k" }],
	/** Switches the scope prompt's pointing mode (plugins/scope-prompt) on or off. */
	"p2.scope-prompt.toggle": [{ key: "." }],
} as const satisfies Readonly<Record<string, readonly KeyChord[]>>;

export type KeyBinding = keyof typeof DEFAULT_KEYS;

/** Whether `event` presses one of `binding`'s chords. */
export function matchesBinding(event: KeyboardEvent, binding: KeyBinding): boolean {
	const primary = APPLE ? event.metaKey : event.ctrlKey;
	const other = APPLE ? event.ctrlKey : event.metaKey;
	if (!primary || other || event.altKey || event.shiftKey) return false;
	const key = event.key.toLowerCase();
	return DEFAULT_KEYS[binding].some((chord) => chord.key === key);
}

/** Modifier-only bindings by id: the modifiers pressed together and released with no other key in between. */
export const MODIFIER_TAPS = {
	/** Opens the next session in the sidebar's order (plugins/sessions). */
	"p2.sessions.next": { primary: true, shift: true },
} as const satisfies Readonly<Record<string, { readonly primary: boolean; readonly shift: boolean }>>;

export type ModifierTap = keyof typeof MODIFIER_TAPS;

/**
 * Calls `onTap` each time `tap`'s modifiers (Cmd on macOS, Ctrl elsewhere, for the primary one) are held together and
 * released without another key or a click in between, so Cmd+Shift+K and Cmd+Shift+click never count. Returns the
 * function that stops listening.
 */
export function listenModifierTap(tap: ModifierTap, onTap: () => void): () => void {
	const wanted = MODIFIER_TAPS[tap];
	const primaryKey = APPLE ? "Meta" : "Control";
	const modifier = (key: string) => key === primaryKey || key === "Shift";
	let armed = false;
	const down = (event: KeyboardEvent) => {
		const primary = APPLE ? event.metaKey : event.ctrlKey;
		const other = APPLE ? event.ctrlKey : event.metaKey;
		armed =
			modifier(event.key) &&
			!event.repeat &&
			primary === wanted.primary &&
			event.shiftKey === wanted.shift &&
			!other &&
			!event.altKey;
	};
	const up = (event: KeyboardEvent) => {
		if (!armed || !modifier(event.key)) return;
		armed = false;
		onTap();
	};
	const disarm = () => {
		armed = false;
	};
	window.addEventListener("keydown", down, true);
	window.addEventListener("keyup", up, true);
	window.addEventListener("pointerdown", disarm, true);
	window.addEventListener("blur", disarm);
	return () => {
		window.removeEventListener("keydown", down, true);
		window.removeEventListener("keyup", up, true);
		window.removeEventListener("pointerdown", disarm, true);
		window.removeEventListener("blur", disarm);
	};
}
