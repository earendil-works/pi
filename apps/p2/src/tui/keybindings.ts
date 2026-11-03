// pi's keybinding ids and defaults, copied from coding-agent core/keybindings.ts (APP_KEYBINDINGS, the KEYBINDINGS
// platform overrides and the legacy-name migration) and core/key-id-schema.ts. Pure data: the platform is the
// guest's (from the launcher's `capabilities`), never this process's. Shared by the launcher and the worker.
import {
	Key,
	type KeybindingDefinitions,
	type KeybindingsConfig,
	type KeyId,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";

export type KeyPlatform = { platform: string; windowsKeys: boolean };
export const DEFAULT_KEY_PLATFORM: KeyPlatform = { platform: "linux", windowsKeys: false };

/** pi's `app.*` table for one guest platform (coding-agent `APP_KEYBINDINGS`). */
export function appKeybindings({ platform, windowsKeys }: KeyPlatform) {
	return {
		"app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
		"app.clear": { defaultKeys: "ctrl+c", description: "Clear editor" },
		"app.exit": { defaultKeys: "ctrl+d", description: "Exit when editor is empty" },
		"app.suspend": { defaultKeys: platform === "win32" ? [] : "ctrl+z", description: "Suspend to background" },
		"app.thinking.cycle": { defaultKeys: "shift+tab", description: "Cycle thinking level" },
		"app.thinking.save": { defaultKeys: "ctrl+s", description: "Save thinking level" },
		"app.model.cycleForward": { defaultKeys: "ctrl+p", description: "Cycle to next model" },
		"app.model.cycleBackward": {
			defaultKeys: windowsKeys ? "alt+p" : "shift+ctrl+p",
			description: "Cycle to previous model",
		},
		"app.model.select": { defaultKeys: "ctrl+l", description: "Open model selector" },
		"app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
		"app.thinking.toggle": { defaultKeys: "ctrl+t", description: "Toggle thinking blocks" },
		"app.session.toggleNamedFilter": { defaultKeys: "ctrl+n", description: "Toggle named session filter" },
		"app.editor.external": { defaultKeys: "ctrl+g", description: "Open external editor" },
		"app.message.copy": { defaultKeys: "ctrl+x", description: "Copy selection or last assistant message" },
		"app.message.followUp": {
			defaultKeys: windowsKeys ? "ctrl+q" : "alt+enter",
			description: "Queue follow-up message",
		},
		"app.message.dequeue": { defaultKeys: windowsKeys ? "alt+q" : "alt+up", description: "Restore queued messages" },
		"app.clipboard.pasteImage": {
			defaultKeys: windowsKeys ? "alt+v" : "ctrl+v",
			description: "Paste files on macOS, images, or text from clipboard",
		},
		"app.session.new": { defaultKeys: [], description: "Start a new session" },
		"app.session.tree": { defaultKeys: [], description: "Open session tree" },
		"app.session.fork": { defaultKeys: [], description: "Fork current session" },
		"app.session.resume": { defaultKeys: [], description: "Resume a session" },
		"app.tree.foldOrUp": {
			defaultKeys: platform === "darwin" ? ["alt+left", "ctrl+left"] : ["ctrl+left", "alt+left"],
			description: "Fold tree branch or move up",
		},
		"app.tree.unfoldOrDown": {
			defaultKeys: platform === "darwin" ? ["alt+right", "ctrl+right"] : ["ctrl+right", "alt+right"],
			description: "Unfold tree branch or move down",
		},
		"app.tree.editLabel": { defaultKeys: "shift+l", description: "Edit tree label" },
		"app.tree.toggleLabelTimestamp": { defaultKeys: "shift+t", description: "Toggle tree label timestamps" },
		"app.session.togglePath": { defaultKeys: "ctrl+p", description: "Toggle session path display" },
		"app.session.toggleSort": { defaultKeys: "ctrl+s", description: "Toggle session sort mode" },
		"app.session.rename": { defaultKeys: "ctrl+r", description: "Rename session" },
		"app.session.delete": { defaultKeys: "ctrl+d", description: "Delete session" },
		"app.session.deleteNoninvasive": {
			defaultKeys: "ctrl+backspace",
			description: "Delete session when query is empty",
		},
		"app.models.save": { defaultKeys: "ctrl+s", description: "Save model selection" },
		"app.models.enableAll": { defaultKeys: "ctrl+a", description: "Enable all models" },
		"app.models.clearAll": { defaultKeys: "ctrl+x", description: "Clear all models" },
		"app.models.toggleProvider": { defaultKeys: "ctrl+p", description: "Toggle all models for provider" },
		"app.models.reorderUp": { defaultKeys: "alt+up", description: "Move model up in order" },
		"app.models.reorderDown": { defaultKeys: "alt+down", description: "Move model down in order" },
		"app.tree.filter.default": { defaultKeys: "ctrl+d", description: "Tree filter: default view" },
		"app.tree.filter.noTools": { defaultKeys: "ctrl+t", description: "Tree filter: hide tool results" },
		"app.tree.filter.userOnly": { defaultKeys: "ctrl+u", description: "Tree filter: user messages only" },
		"app.tree.filter.labeledOnly": { defaultKeys: "ctrl+l", description: "Tree filter: labeled entries only" },
		"app.tree.filter.all": { defaultKeys: "ctrl+a", description: "Tree filter: show all entries" },
		"app.tree.filter.cycleForward": { defaultKeys: "ctrl+o", description: "Tree filter: cycle forward" },
		"app.tree.filter.cycleBackward": { defaultKeys: "shift+ctrl+o", description: "Tree filter: cycle backward" },
		// p2-only launcher action (section 3.2): opens the launcher's local file picker. Unbound by default.
		"p2.attach": { defaultKeys: [], description: "Attach a local file (launcher)" },
	} as const satisfies KeybindingDefinitions;
}
export type AppKeybinding = keyof ReturnType<typeof appKeybindings>;
type AppBindings = { [K in AppKeybinding]: true };
declare module "@earendil-works/pi-tui" {
	interface Keybindings extends AppBindings {}
}

/** pi's full built-in table (`KEYBINDINGS`): pi-tui ids with coding-agent's platform overrides, then `app.*`. */
export function builtinKeybindings(keyPlatform: KeyPlatform = DEFAULT_KEY_PLATFORM): KeybindingDefinitions {
	const { platform, windowsKeys } = keyPlatform;
	return {
		...TUI_KEYBINDINGS,
		"tui.editor.undo": {
			...TUI_KEYBINDINGS["tui.editor.undo"],
			defaultKeys: platform === "win32" ? "ctrl+z" : windowsKeys ? "alt+z" : "ctrl+-",
		},
		"tui.altScreen.previousPrompt": {
			...TUI_KEYBINDINGS["tui.altScreen.previousPrompt"],
			defaultKeys: windowsKeys ? "ctrl+up" : ["ctrl+shift+up", "ctrl+up"],
		},
		"tui.altScreen.nextPrompt": {
			...TUI_KEYBINDINGS["tui.altScreen.nextPrompt"],
			defaultKeys: windowsKeys ? "ctrl+down" : ["ctrl+shift+down", "ctrl+down"],
		},
		"tui.altScreen.search": {
			...TUI_KEYBINDINGS["tui.altScreen.search"],
			defaultKeys: windowsKeys ? "ctrl+f" : "ctrl+shift+f",
		},
		...appKeybindings(keyPlatform),
	};
}

/** Launcher-owned action ids (section 3.1 K grants). The worker can never bind or rebind them. */
export const PRIVILEGED_ACTIONS: readonly string[] = [
	"app.clipboard.pasteImage",
	"app.editor.external",
	"app.suspend",
	"app.message.copy",
	"p2.attach",
];
export const isPrivileged = (id: string): boolean => PRIVILEGED_ACTIONS.includes(id);

const KEYBINDING_NAME_MIGRATIONS: Record<string, string> = {
	cursorUp: "tui.editor.cursorUp",
	cursorDown: "tui.editor.cursorDown",
	cursorLeft: "tui.editor.cursorLeft",
	cursorRight: "tui.editor.cursorRight",
	cursorWordLeft: "tui.editor.cursorWordLeft",
	cursorWordRight: "tui.editor.cursorWordRight",
	cursorLineStart: "tui.editor.cursorLineStart",
	cursorLineEnd: "tui.editor.cursorLineEnd",
	jumpForward: "tui.editor.jumpForward",
	jumpBackward: "tui.editor.jumpBackward",
	pageUp: "tui.editor.pageUp",
	pageDown: "tui.editor.pageDown",
	deleteCharBackward: "tui.editor.deleteCharBackward",
	deleteCharForward: "tui.editor.deleteCharForward",
	deleteWordBackward: "tui.editor.deleteWordBackward",
	deleteWordForward: "tui.editor.deleteWordForward",
	deleteToLineStart: "tui.editor.deleteToLineStart",
	deleteToLineEnd: "tui.editor.deleteToLineEnd",
	yank: "tui.editor.yank",
	yankPop: "tui.editor.yankPop",
	undo: "tui.editor.undo",
	newLine: "tui.input.newLine",
	submit: "tui.input.submit",
	tab: "tui.input.tab",
	copy: "tui.input.copy",
	selectUp: "tui.select.up",
	selectDown: "tui.select.down",
	selectPageUp: "tui.select.pageUp",
	selectPageDown: "tui.select.pageDown",
	selectConfirm: "tui.select.confirm",
	selectCancel: "tui.select.cancel",
	interrupt: "app.interrupt",
	clear: "app.clear",
	exit: "app.exit",
	suspend: "app.suspend",
	cycleThinkingLevel: "app.thinking.cycle",
	cycleModelForward: "app.model.cycleForward",
	cycleModelBackward: "app.model.cycleBackward",
	selectModel: "app.model.select",
	expandTools: "app.tools.expand",
	toggleThinking: "app.thinking.toggle",
	toggleSessionNamedFilter: "app.session.toggleNamedFilter",
	externalEditor: "app.editor.external",
	followUp: "app.message.followUp",
	dequeue: "app.message.dequeue",
	pasteImage: "app.clipboard.pasteImage",
	newSession: "app.session.new",
	tree: "app.session.tree",
	fork: "app.session.fork",
	resume: "app.session.resume",
	treeFoldOrUp: "app.tree.foldOrUp",
	treeUnfoldOrDown: "app.tree.unfoldOrDown",
	treeEditLabel: "app.tree.editLabel",
	treeToggleLabelTimestamp: "app.tree.toggleLabelTimestamp",
	toggleSessionPath: "app.session.togglePath",
	toggleSessionSort: "app.session.toggleSort",
	renameSession: "app.session.rename",
	deleteSession: "app.session.delete",
	deleteSessionNoninvasive: "app.session.deleteNoninvasive",
};

const MODIFIERS = ["ctrl", "shift", "alt", "super"] as const;
const BASE_KEY = `(?:[a-z0-9]|${Object.values(Key)
	.flatMap((value) => (typeof value === "string" ? [value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")] : []))
	.join("|")})`;
const DUPLICATE_MODIFIER = MODIFIERS.map((modifier) => `${modifier}\\+.*${modifier}\\+`).join("|");
const KEY_ID = new RegExp(`^(?!.*(?:${DUPLICATE_MODIFIER}))(?:(?:${MODIFIERS.join("|")})\\+){0,4}${BASE_KEY}$`);
const KEYBINDING_ID = /^[A-Za-z][\w-]*(?:\.[A-Za-z][\w-]*)+$/;
const MAX_KEYS = 8;

export function isKeyId(value: unknown): value is KeyId {
	return typeof value === "string" && value.length <= 64 && KEY_ID.test(value);
}

/**
 * Validate one keybindings document (pi `keybindings.json` or the `keybindings` object of p2 prefs): migrate legacy
 * names, keep only well-formed ids with valid key ids (pi's KeyIdSchema), and report what was dropped.
 */
export function sanitizeKeybindings(raw: unknown): { config: KeybindingsConfig; invalid: string[] } {
	const config: KeybindingsConfig = {};
	const invalid: string[] = [];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { config, invalid };
	const entries = Object.entries(raw as Record<string, unknown>);
	for (const [key, value] of entries) {
		if (key === "$schema") continue;
		const id = KEYBINDING_NAME_MIGRATIONS[key] ?? key;
		// pi: an explicit new-style name wins over its legacy alias.
		if (id !== key && Object.hasOwn(raw, id)) continue;
		const keys = Array.isArray(value) ? value : [value];
		if (!KEYBINDING_ID.test(id) || id.length > 128 || keys.length > MAX_KEYS || !keys.every(isKeyId)) {
			invalid.push(key.slice(0, 128));
			continue;
		}
		config[id] = Array.isArray(value) ? (keys as KeyId[]) : (value as KeyId);
	}
	return { config, invalid };
}

const keyList = (keys: KeyId | readonly KeyId[] | undefined): KeyId[] =>
	keys === undefined ? [] : Array.isArray(keys) ? [...keys] : [keys as KeyId];

export type PrivilegedResolution = {
	/** Effective launcher keys per privileged id. */
	keys: Record<string, KeyId[]>;
	/** Keys a privileged action lost to a non-privileged binding (shown by /hotkeys). */
	lost: { id: string; key: KeyId; to: string }[];
};

/**
 * Section 6.2 "privileged vs anything": a privileged key colliding with any non-privileged binding keeps the key only
 * when pi has the same default collision (pi resolves it by mode, e.g. Ctrl+G = external editor / search next, where
 * the worker suspends interception while searching). Otherwise the privileged action loses the key.
 */
export function resolvePrivilegedKeys(
	definitions: KeybindingDefinitions,
	user: KeybindingsConfig,
): PrivilegedResolution {
	const effective = (id: string): KeyId[] =>
		user[id] !== undefined ? keyList(user[id]) : keyList(definitions[id]?.defaultKeys);
	const others = new Map<KeyId, string[]>();
	const claim = (id: string, keys: readonly KeyId[]) => {
		for (const key of keys) others.set(key, [...(others.get(key) ?? []), id]);
	};
	for (const id of Object.keys(definitions)) if (!isPrivileged(id)) claim(id, effective(id));
	// User bindings for ids the launcher does not know (plugin commands) count too; plugin defaults never do.
	for (const [id, keys] of Object.entries(user))
		if (!isPrivileged(id) && !(id in definitions)) claim(id, keyList(keys));
	const resolution: PrivilegedResolution = { keys: {}, lost: [] };
	for (const id of PRIVILEGED_ACTIONS) {
		const kept: KeyId[] = [];
		for (const key of effective(id)) {
			const colliding = (others.get(key) ?? []).filter(
				(other) =>
					!(
						keyList(definitions[id]?.defaultKeys).includes(key) &&
						user[id] === undefined &&
						user[other] === undefined &&
						keyList(definitions[other]?.defaultKeys).includes(key)
					),
			);
			if (colliding.length) resolution.lost.push({ id, key, to: colliding[0]! });
			else kept.push(key);
		}
		resolution.keys[id] = kept;
	}
	return resolution;
}
