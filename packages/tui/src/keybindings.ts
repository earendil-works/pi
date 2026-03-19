import { type KeyId, matchesKey } from "./keys.js";

export type KeybindingScope = "global" | "editor" | "selection" | "sessionPicker" | "treePicker";

/**
 * Editor actions that can be bound to keys.
 */
export type EditorAction =
	// Cursor movement
	| "cursorUp"
	| "cursorDown"
	| "cursorLeft"
	| "cursorRight"
	| "cursorWordLeft"
	| "cursorWordRight"
	| "cursorLineStart"
	| "cursorLineEnd"
	| "jumpForward"
	| "jumpBackward"
	| "pageUp"
	| "pageDown"
	// Deletion
	| "deleteCharBackward"
	| "deleteCharForward"
	| "deleteWordBackward"
	| "deleteWordForward"
	| "deleteToLineStart"
	| "deleteToLineEnd"
	// Text input
	| "newLine"
	| "submit"
	| "tab"
	// Selection/autocomplete
	| "selectUp"
	| "selectDown"
	| "selectPageUp"
	| "selectPageDown"
	| "selectConfirm"
	| "selectCancel"
	// Clipboard
	| "copy"
	// Kill ring
	| "yank"
	| "yankPop"
	// Undo
	| "undo"
	// Tool output
	| "expandTools"
	// Tree navigation
	| "treeFoldOrUp"
	| "treeUnfoldOrDown"
	// Session
	| "toggleSessionPath"
	| "toggleSessionSort"
	| "renameSession"
	| "deleteSession"
	| "deleteSessionNoninvasive";

// Re-export KeyId from keys.ts
export type { KeyId };

/**
 * Editor keybindings configuration.
 */
export type EditorKeybindingsConfig = {
	[K in EditorAction]?: KeyId | KeyId[];
};

export interface EditorKeybindingMetadata {
	keys: KeyId | KeyId[];
	scope: KeybindingScope;
}

/**
 * Default editor keybinding metadata.
 */
export const DEFAULT_EDITOR_KEYBINDING_METADATA: Record<EditorAction, EditorKeybindingMetadata> = {
	// Cursor movement
	cursorUp: { keys: "up", scope: "editor" },
	cursorDown: { keys: "down", scope: "editor" },
	cursorLeft: { keys: ["left", "ctrl+b"], scope: "editor" },
	cursorRight: { keys: ["right", "ctrl+f"], scope: "editor" },
	cursorWordLeft: { keys: ["alt+left", "ctrl+left", "alt+b"], scope: "editor" },
	cursorWordRight: { keys: ["alt+right", "ctrl+right", "alt+f"], scope: "editor" },
	cursorLineStart: { keys: ["home", "ctrl+a"], scope: "editor" },
	cursorLineEnd: { keys: ["end", "ctrl+e"], scope: "editor" },
	jumpForward: { keys: "ctrl+]", scope: "editor" },
	jumpBackward: { keys: "ctrl+alt+]", scope: "editor" },
	pageUp: { keys: "pageUp", scope: "editor" },
	pageDown: { keys: "pageDown", scope: "editor" },
	// Deletion
	deleteCharBackward: { keys: "backspace", scope: "editor" },
	deleteCharForward: { keys: ["delete", "ctrl+d"], scope: "editor" },
	deleteWordBackward: { keys: ["ctrl+w", "alt+backspace"], scope: "editor" },
	deleteWordForward: { keys: ["alt+d", "alt+delete"], scope: "editor" },
	deleteToLineStart: { keys: "ctrl+u", scope: "editor" },
	deleteToLineEnd: { keys: "ctrl+k", scope: "editor" },
	// Text input
	newLine: { keys: "shift+enter", scope: "editor" },
	submit: { keys: "enter", scope: "editor" },
	tab: { keys: "tab", scope: "editor" },
	// Selection/autocomplete
	selectUp: { keys: "up", scope: "selection" },
	selectDown: { keys: "down", scope: "selection" },
	selectPageUp: { keys: "pageUp", scope: "selection" },
	selectPageDown: { keys: "pageDown", scope: "selection" },
	selectConfirm: { keys: "enter", scope: "selection" },
	selectCancel: { keys: ["escape", "ctrl+c"], scope: "selection" },
	// Clipboard
	copy: { keys: "ctrl+c", scope: "editor" },
	// Kill ring
	yank: { keys: "ctrl+y", scope: "editor" },
	yankPop: { keys: "alt+y", scope: "editor" },
	// Undo
	undo: { keys: "ctrl+-", scope: "editor" },
	// Tool output
	expandTools: { keys: "ctrl+o", scope: "editor" },
	// Tree navigation
	treeFoldOrUp: { keys: ["ctrl+left", "alt+left"], scope: "treePicker" },
	treeUnfoldOrDown: { keys: ["ctrl+right", "alt+right"], scope: "treePicker" },
	// Session
	toggleSessionPath: { keys: "ctrl+p", scope: "sessionPicker" },
	toggleSessionSort: { keys: "ctrl+s", scope: "sessionPicker" },
	renameSession: { keys: "ctrl+r", scope: "sessionPicker" },
	deleteSession: { keys: "ctrl+d", scope: "sessionPicker" },
	deleteSessionNoninvasive: { keys: "ctrl+backspace", scope: "sessionPicker" },
};

/**
 * Default editor keybindings.
 */
export const DEFAULT_EDITOR_KEYBINDINGS: Required<EditorKeybindingsConfig> = Object.fromEntries(
	Object.entries(DEFAULT_EDITOR_KEYBINDING_METADATA).map(([action, metadata]) => [action, metadata.keys]),
) as Required<EditorKeybindingsConfig>;

/**
 * Manages keybindings for the editor.
 */
export class EditorKeybindingsManager {
	private actionToKeys: Map<EditorAction, KeyId[]>;

	constructor(config: EditorKeybindingsConfig = {}) {
		this.actionToKeys = new Map();
		this.buildMaps(config);
	}

	private buildMaps(config: EditorKeybindingsConfig): void {
		this.actionToKeys.clear();

		// Start with defaults
		for (const [action, metadata] of Object.entries(DEFAULT_EDITOR_KEYBINDING_METADATA)) {
			const keyArray = Array.isArray(metadata.keys) ? metadata.keys : [metadata.keys];
			this.actionToKeys.set(action as EditorAction, [...keyArray]);
		}

		// Override with user config
		for (const [action, keys] of Object.entries(config)) {
			if (keys === undefined) continue;
			const keyArray = Array.isArray(keys) ? keys : [keys];
			this.actionToKeys.set(action as EditorAction, keyArray);
		}
	}

	/**
	 * Check if input matches a specific action.
	 */
	matches(data: string, action: EditorAction): boolean {
		const keys = this.actionToKeys.get(action);
		if (!keys) return false;
		for (const key of keys) {
			if (matchesKey(data, key)) return true;
		}
		return false;
	}

	/**
	 * Get keys bound to an action.
	 */
	getKeys(action: EditorAction): KeyId[] {
		return this.actionToKeys.get(action) ?? [];
	}

	/**
	 * Update configuration.
	 */
	setConfig(config: EditorKeybindingsConfig): void {
		this.buildMaps(config);
	}
}

// Global instance
let globalEditorKeybindings: EditorKeybindingsManager | null = null;

export function getEditorKeybindings(): EditorKeybindingsManager {
	if (!globalEditorKeybindings) {
		globalEditorKeybindings = new EditorKeybindingsManager();
	}
	return globalEditorKeybindings;
}

export function setEditorKeybindings(manager: EditorKeybindingsManager): void {
	globalEditorKeybindings = manager;
}
