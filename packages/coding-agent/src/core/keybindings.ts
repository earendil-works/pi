import {
	type Keybinding,
	type KeybindingDefinitions,
	type KeybindingsConfig,
	type KeyId,
	TUI_KEYBINDINGS,
	KeybindingsManager as TuiKeybindingsManager,
	t,
} from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "../config.ts";

export interface AppKeybindings {
	"app.interrupt": true;
	"app.clear": true;
	"app.exit": true;
	"app.suspend": true;
	"app.thinking.cycle": true;
	"app.model.cycleForward": true;
	"app.model.cycleBackward": true;
	"app.model.select": true;
	"app.tools.expand": true;
	"app.thinking.toggle": true;
	"app.session.toggleNamedFilter": true;
	"app.editor.external": true;
	"app.message.copy": true;
	"app.message.followUp": true;
	"app.message.dequeue": true;
	"app.clipboard.pasteImage": true;
	"app.session.new": true;
	"app.session.tree": true;
	"app.session.fork": true;
	"app.session.resume": true;
	"app.tree.foldOrUp": true;
	"app.tree.unfoldOrDown": true;
	"app.tree.editLabel": true;
	"app.tree.toggleLabelTimestamp": true;
	"app.session.togglePath": true;
	"app.session.toggleSort": true;
	"app.session.rename": true;
	"app.session.delete": true;
	"app.session.deleteNoninvasive": true;
	"app.models.save": true;
	"app.models.enableAll": true;
	"app.models.clearAll": true;
	"app.models.toggleProvider": true;
	"app.models.reorderUp": true;
	"app.models.reorderDown": true;
	"app.tree.filter.default": true;
	"app.tree.filter.noTools": true;
	"app.tree.filter.userOnly": true;
	"app.tree.filter.labeledOnly": true;
	"app.tree.filter.all": true;
	"app.tree.filter.cycleForward": true;
	"app.tree.filter.cycleBackward": true;
}

export type AppKeybinding = keyof AppKeybindings;

declare module "@earendil-works/pi-tui" {
	interface Keybindings extends AppKeybindings {}
}

export const KEYBINDINGS = {
	...TUI_KEYBINDINGS,
	"app.interrupt": { defaultKeys: "escape", description: t("keybindings.app.interrupt") },
	"app.clear": { defaultKeys: "ctrl+c", description: t("keybindings.app.clear") },
	"app.exit": { defaultKeys: "ctrl+d", description: t("keybindings.app.exit") },
	"app.suspend": {
		defaultKeys: process.platform === "win32" ? [] : "ctrl+z",
		description: t("keybindings.app.suspend"),
	},
	"app.thinking.cycle": {
		defaultKeys: "shift+tab",
		description: t("keybindings.app.thinking.cycle"),
	},
	"app.model.cycleForward": {
		defaultKeys: "ctrl+p",
		description: t("keybindings.app.model.cycleForward"),
	},
	"app.model.cycleBackward": {
		defaultKeys: "shift+ctrl+p",
		description: t("keybindings.app.model.cycleBackward"),
	},
	"app.model.select": { defaultKeys: "ctrl+l", description: t("keybindings.app.model.select") },
	"app.tools.expand": { defaultKeys: "ctrl+o", description: t("keybindings.app.tools.expand") },
	"app.thinking.toggle": {
		defaultKeys: "ctrl+t",
		description: t("keybindings.app.thinking.toggle"),
	},
	"app.session.toggleNamedFilter": {
		defaultKeys: "ctrl+n",
		description: t("keybindings.app.session.toggleNamedFilter"),
	},
	"app.editor.external": {
		defaultKeys: "ctrl+g",
		description: t("keybindings.app.editor.external"),
	},
	"app.message.copy": {
		defaultKeys: "ctrl+x",
		description: t("keybindings.app.message.copy"),
	},
	"app.message.followUp": {
		defaultKeys: "alt+enter",
		description: t("keybindings.app.message.followUp"),
	},
	"app.message.dequeue": {
		defaultKeys: "alt+up",
		description: t("keybindings.app.message.dequeue"),
	},
	"app.clipboard.pasteImage": {
		defaultKeys: process.platform === "win32" ? "alt+v" : "ctrl+v",
		description: t("keybindings.app.clipboard.pasteImage"),
	},
	"app.session.new": { defaultKeys: [], description: t("keybindings.app.session.new") },
	"app.session.tree": { defaultKeys: [], description: t("keybindings.app.session.tree") },
	"app.session.fork": { defaultKeys: [], description: t("keybindings.app.session.fork") },
	"app.session.resume": { defaultKeys: [], description: t("keybindings.app.session.resume") },
	"app.tree.foldOrUp": {
		defaultKeys: process.platform === "darwin" ? ["alt+left", "ctrl+left"] : ["ctrl+left", "alt+left"],
		description: t("keybindings.app.tree.foldOrUp"),
	},
	"app.tree.unfoldOrDown": {
		defaultKeys: process.platform === "darwin" ? ["alt+right", "ctrl+right"] : ["ctrl+right", "alt+right"],
		description: t("keybindings.app.tree.unfoldOrDown"),
	},
	"app.tree.editLabel": {
		defaultKeys: "shift+l",
		description: t("keybindings.app.tree.editLabel"),
	},
	"app.tree.toggleLabelTimestamp": {
		defaultKeys: "shift+t",
		description: t("keybindings.app.tree.toggleLabelTimestamp"),
	},
	"app.session.togglePath": {
		defaultKeys: "ctrl+p",
		description: t("keybindings.app.session.togglePath"),
	},
	"app.session.toggleSort": {
		defaultKeys: "ctrl+s",
		description: t("keybindings.app.session.toggleSort"),
	},
	"app.session.rename": {
		defaultKeys: "ctrl+r",
		description: t("keybindings.app.session.rename"),
	},
	"app.session.delete": {
		defaultKeys: "ctrl+d",
		description: t("keybindings.app.session.delete"),
	},
	"app.session.deleteNoninvasive": {
		defaultKeys: "ctrl+backspace",
		description: t("keybindings.app.session.deleteNoninvasive"),
	},
	"app.models.save": {
		defaultKeys: "ctrl+s",
		description: t("keybindings.app.models.save"),
	},
	"app.models.enableAll": {
		defaultKeys: "ctrl+a",
		description: t("keybindings.app.models.enableAll"),
	},
	"app.models.clearAll": {
		defaultKeys: "ctrl+x",
		description: t("keybindings.app.models.clearAll"),
	},
	"app.models.toggleProvider": {
		defaultKeys: "ctrl+p",
		description: t("keybindings.app.models.toggleProvider"),
	},
	"app.models.reorderUp": {
		defaultKeys: "alt+up",
		description: t("keybindings.app.models.reorderUp"),
	},
	"app.models.reorderDown": {
		defaultKeys: "alt+down",
		description: t("keybindings.app.models.reorderDown"),
	},
	"app.tree.filter.default": {
		defaultKeys: "ctrl+d",
		description: t("keybindings.app.tree.filter.default"),
	},
	"app.tree.filter.noTools": {
		defaultKeys: "ctrl+t",
		description: t("keybindings.app.tree.filter.noTools"),
	},
	"app.tree.filter.userOnly": {
		defaultKeys: "ctrl+u",
		description: t("keybindings.app.tree.filter.userOnly"),
	},
	"app.tree.filter.labeledOnly": {
		defaultKeys: "ctrl+l",
		description: t("keybindings.app.tree.filter.labeledOnly"),
	},
	"app.tree.filter.all": {
		defaultKeys: "ctrl+a",
		description: t("keybindings.app.tree.filter.all"),
	},
	"app.tree.filter.cycleForward": {
		defaultKeys: "ctrl+o",
		description: t("keybindings.app.tree.filter.cycleForward"),
	},
	"app.tree.filter.cycleBackward": {
		defaultKeys: "shift+ctrl+o",
		description: t("keybindings.app.tree.filter.cycleBackward"),
	},
} as const satisfies KeybindingDefinitions;

const KEYBINDING_NAME_MIGRATIONS = {
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
} as const satisfies Record<string, Keybinding>;

function isLegacyKeybindingName(key: string): key is keyof typeof KEYBINDING_NAME_MIGRATIONS {
	return key in KEYBINDING_NAME_MIGRATIONS;
}

function toKeybindingsConfig(value: Record<string, unknown>): KeybindingsConfig {
	const config: KeybindingsConfig = {};
	for (const [key, binding] of Object.entries(value)) {
		if (typeof binding === "string") {
			config[key] = binding as KeyId;
			continue;
		}
		if (Array.isArray(binding) && binding.every((entry) => typeof entry === "string")) {
			config[key] = binding as KeyId[];
		}
	}
	return config;
}

export function migrateKeybindingsConfig(rawConfig: Record<string, unknown>): {
	config: Record<string, unknown>;
	migrated: boolean;
} {
	const config: Record<string, unknown> = {};
	let migrated = false;

	for (const [key, value] of Object.entries(rawConfig)) {
		const nextKey = isLegacyKeybindingName(key) ? KEYBINDING_NAME_MIGRATIONS[key] : key;
		if (nextKey !== key) {
			migrated = true;
		}
		if (key !== nextKey && Object.hasOwn(rawConfig, nextKey)) {
			migrated = true;
			continue;
		}
		config[nextKey] = value;
	}

	return { config: orderKeybindingsConfig(config), migrated };
}

function orderKeybindingsConfig(config: Record<string, unknown>): Record<string, unknown> {
	const ordered: Record<string, unknown> = {};
	for (const keybinding of Object.keys(KEYBINDINGS)) {
		if (Object.hasOwn(config, keybinding)) {
			ordered[keybinding] = config[keybinding];
		}
	}

	const extras = Object.keys(config)
		.filter((key) => !Object.hasOwn(ordered, key))
		.sort();
	for (const key of extras) {
		ordered[key] = config[key];
	}

	return ordered;
}

function loadRawConfig(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null) return undefined;
		return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

export class KeybindingsManager extends TuiKeybindingsManager {
	private configPath: string | undefined;

	constructor(userBindings: KeybindingsConfig = {}, configPath?: string) {
		super(KEYBINDINGS, userBindings);
		this.configPath = configPath;
	}

	static create(agentDir: string = getAgentDir()): KeybindingsManager {
		const configPath = join(agentDir, "keybindings.json");
		const userBindings = KeybindingsManager.loadFromFile(configPath);
		return new KeybindingsManager(userBindings, configPath);
	}

	reload(): void {
		if (!this.configPath) return;
		this.setUserBindings(KeybindingsManager.loadFromFile(this.configPath));
	}

	getEffectiveConfig(): KeybindingsConfig {
		return this.getResolvedBindings();
	}

	private static loadFromFile(path: string): KeybindingsConfig {
		const rawConfig = loadRawConfig(path);
		if (!rawConfig) return {};
		return toKeybindingsConfig(migrateKeybindingsConfig(rawConfig).config);
	}
}

export type { Keybinding, KeyId, KeybindingsConfig };
