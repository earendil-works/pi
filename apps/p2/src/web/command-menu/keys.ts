// The web's default key table: modifier shortcuts by binding id, starting with the command menu's. A later keybinding
// table (and shortcuts for commands) extends it instead of checking keys in place.

/** A key pressed with the platform's primary modifier (Cmd on macOS, Ctrl elsewhere) and no other modifier. */
export type KeyChord = { readonly key: string };

/** The default bindings by id. */
export const DEFAULT_KEYS = {
	"p2.commands.open": [{ key: "k" }],
	/** Switches the scope prompt's pointing mode (plugins/scope-prompt) on or off. */
	"p2.scope-prompt.toggle": [{ key: "." }],
} as const satisfies Readonly<Record<string, readonly KeyChord[]>>;

export type KeyBinding = keyof typeof DEFAULT_KEYS;

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/** Whether `event` presses one of `binding`'s chords. */
export function matchesBinding(event: KeyboardEvent, binding: KeyBinding): boolean {
	const primary = MAC ? event.metaKey : event.ctrlKey;
	const other = MAC ? event.ctrlKey : event.metaKey;
	if (!primary || other || event.altKey || event.shiftKey) return false;
	const key = event.key.toLowerCase();
	return DEFAULT_KEYS[binding].some((chord) => chord.key === key);
}
