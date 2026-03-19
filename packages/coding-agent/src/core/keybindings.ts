import {
	DEFAULT_EDITOR_KEYBINDINGS,
	type EditorAction,
	type EditorKeybindingsConfig,
	EditorKeybindingsManager,
	type KeybindingScope,
	type KeyId,
	matchesKey,
	setEditorKeybindings,
} from "@mariozechner/pi-tui";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "../config.js";

/**
 * Application-level actions (coding agent specific).
 */
export type AppAction =
	| "interrupt"
	| "clear"
	| "exit"
	| "suspend"
	| "cycleThinkingLevel"
	| "cycleModelForward"
	| "cycleModelBackward"
	| "selectModel"
	| "expandTools"
	| "toggleThinking"
	| "toggleSessionNamedFilter"
	| "externalEditor"
	| "followUp"
	| "dequeue"
	| "pasteImage"
	| "newSession"
	| "tree"
	| "fork"
	| "resume";

/**
 * All configurable actions.
 */
export type KeyAction = AppAction | EditorAction;

/**
 * Full keybindings configuration (app + editor actions).
 */
export type KeybindingsConfig = {
	[K in KeyAction]?: KeyId | KeyId[];
};

/**
 * Default application keybinding metadata.
 */
export const DEFAULT_APP_KEYBINDING_METADATA: Record<AppAction, AppKeybindingMetadata> = {
	interrupt: { keys: "escape", scope: "global" },
	clear: { keys: "ctrl+c", scope: "editor" },
	exit: { keys: "ctrl+d", scope: "editor" },
	suspend: { keys: "ctrl+z", scope: "global" },
	cycleThinkingLevel: { keys: "shift+tab", scope: "global" },
	cycleModelForward: { keys: "ctrl+p", scope: "editor" },
	cycleModelBackward: { keys: "shift+ctrl+p", scope: "editor" },
	selectModel: { keys: "ctrl+l", scope: "editor" },
	expandTools: { keys: "ctrl+o", scope: "editor" },
	toggleThinking: { keys: "ctrl+t", scope: "global" },
	toggleSessionNamedFilter: { keys: "ctrl+n", scope: "sessionPicker" },
	externalEditor: { keys: "ctrl+g", scope: "editor" },
	followUp: { keys: "alt+enter", scope: "editor" },
	dequeue: { keys: "alt+up", scope: "editor" },
	pasteImage: { keys: process.platform === "win32" ? "alt+v" : "ctrl+v", scope: "editor" },
	newSession: { keys: [], scope: "global" },
	tree: { keys: [], scope: "global" },
	fork: { keys: [], scope: "global" },
	resume: { keys: [], scope: "global" },
};

/**
 * Default application keybindings.
 */
export const DEFAULT_APP_KEYBINDINGS: Record<AppAction, KeyId | KeyId[]> = Object.fromEntries(
	Object.entries(DEFAULT_APP_KEYBINDING_METADATA).map(([action, metadata]) => [action, metadata.keys]),
) as Record<AppAction, KeyId | KeyId[]>;

export interface AppKeybindingMetadata {
	keys: KeyId | KeyId[];
	scope: KeybindingScope;
}

/**
 * All default keybindings (app + editor).
 */
export const DEFAULT_KEYBINDINGS: Required<KeybindingsConfig> = {
	...DEFAULT_EDITOR_KEYBINDINGS,
	...DEFAULT_APP_KEYBINDINGS,
};

// App actions list for type checking
const APP_ACTIONS: AppAction[] = [
	"interrupt",
	"clear",
	"exit",
	"suspend",
	"cycleThinkingLevel",
	"cycleModelForward",
	"cycleModelBackward",
	"selectModel",
	"expandTools",
	"toggleThinking",
	"toggleSessionNamedFilter",
	"externalEditor",
	"followUp",
	"dequeue",
	"pasteImage",
	"newSession",
	"tree",
	"fork",
	"resume",
];

function isAppAction(action: string): action is AppAction {
	return APP_ACTIONS.includes(action as AppAction);
}

/**
 * Manages all keybindings (app + editor).
 */
export class KeybindingsManager {
	private config: KeybindingsConfig;
	private configPath: string | undefined;
	private appActionToKeys: Map<AppAction, KeyId[]>;

	private constructor(config: KeybindingsConfig, configPath?: string) {
		this.config = config;
		this.configPath = configPath;
		this.appActionToKeys = new Map();
		this.buildMaps();
	}

	/**
	 * Create from config file and set up editor keybindings.
	 */
	static create(agentDir: string = getAgentDir()): KeybindingsManager {
		const configPath = join(agentDir, "keybindings.json");
		const config = KeybindingsManager.loadFromFile(configPath);
		const manager = new KeybindingsManager(config, configPath);
		manager.applyEditorKeybindings();
		return manager;
	}

	/**
	 * Create in-memory.
	 */
	static inMemory(config: KeybindingsConfig = {}): KeybindingsManager {
		return new KeybindingsManager(config);
	}

	reload(): void {
		if (!this.configPath) return;
		this.config = KeybindingsManager.loadFromFile(this.configPath);
		this.buildMaps();
		this.applyEditorKeybindings();
	}

	private static loadFromFile(path: string): KeybindingsConfig {
		if (!existsSync(path)) return {};
		try {
			return JSON.parse(readFileSync(path, "utf-8"));
		} catch {
			return {};
		}
	}

	private buildMaps(): void {
		this.appActionToKeys.clear();

		// Set defaults for app actions
		for (const [action, metadata] of Object.entries(DEFAULT_APP_KEYBINDING_METADATA)) {
			const keyArray = Array.isArray(metadata.keys) ? metadata.keys : [metadata.keys];
			this.appActionToKeys.set(action as AppAction, [...keyArray]);
		}

		// Override with user config (app actions only)
		for (const [action, keys] of Object.entries(this.config)) {
			if (keys === undefined || !isAppAction(action)) continue;
			const keyArray = Array.isArray(keys) ? keys : [keys];
			this.appActionToKeys.set(action, keyArray);
		}
	}

	private applyEditorKeybindings(): void {
		const editorConfig: EditorKeybindingsConfig = {};
		for (const [action, keys] of Object.entries(this.config)) {
			if (!isAppAction(action) || action === "expandTools") {
				editorConfig[action as EditorAction] = keys;
			}
		}
		setEditorKeybindings(new EditorKeybindingsManager(editorConfig));
	}

	/**
	 * Check if input matches an app action.
	 */
	matches(data: string, action: AppAction): boolean {
		const keys = this.appActionToKeys.get(action);
		if (!keys) return false;
		for (const key of keys) {
			if (matchesKey(data, key)) return true;
		}
		return false;
	}

	/**
	 * Get keys bound to an app action.
	 */
	getKeys(action: AppAction): KeyId[] {
		return this.appActionToKeys.get(action) ?? [];
	}

	/**
	 * Get the full effective config.
	 */
	getEffectiveConfig(): Required<KeybindingsConfig> {
		const result = { ...DEFAULT_KEYBINDINGS };
		for (const [action, keys] of Object.entries(this.config)) {
			if (keys !== undefined) {
				(result as KeybindingsConfig)[action as KeyAction] = keys;
			}
		}
		return result;
	}
}

// Re-export for convenience
export type { EditorAction, KeyId };
