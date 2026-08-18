import { t } from "@earendil-works/pi-tui";
import { APP_NAME } from "../config.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	argumentHint?: string;
}

/**
 * Get built-in slash commands with localized descriptions.
 * Call this function after i18n is initialized.
 */
export function getBuiltinSlashCommands(): ReadonlyArray<BuiltinSlashCommand> {
	return [
		{ name: "settings", description: t("codingAgent.slash.settings") },
		{ name: "model", description: t("codingAgent.slash.model"), argumentHint: "<provider/model>" },
		{ name: "scoped-models", description: t("codingAgent.slash.scopedModels") },
		{ name: "export", description: t("codingAgent.slash.export") },
		{ name: "import", description: t("codingAgent.slash.import") },
		{ name: "share", description: t("codingAgent.slash.share") },
		{ name: "copy", description: t("codingAgent.slash.copy") },
		{ name: "name", description: t("codingAgent.slash.name") },
		{ name: "session", description: t("codingAgent.slash.session") },
		{ name: "changelog", description: t("codingAgent.slash.changelog") },
		{ name: "hotkeys", description: t("codingAgent.slash.hotkeys") },
		{ name: "fork", description: t("codingAgent.slash.fork") },
		{ name: "clone", description: t("codingAgent.slash.clone") },
		{ name: "tree", description: t("codingAgent.slash.tree") },
		{ name: "trust", description: t("codingAgent.slash.trust") },
		{ name: "login", description: t("codingAgent.slash.login"), argumentHint: "<provider>" },
		{ name: "logout", description: t("codingAgent.slash.logout") },
		{ name: "new", description: t("codingAgent.slash.new") },
		{ name: "compact", description: t("codingAgent.slash.compact") },
		{ name: "resume", description: t("codingAgent.slash.resume") },
		{ name: "reload", description: t("codingAgent.slash.reload") },
		{ name: "quit", description: t("codingAgent.slash.quit", { appName: APP_NAME }) },
	];
}

// Re-export for backward compatibility (non-localized, uses English keys)
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: t("codingAgent.slashFallback.settings") },
	{ name: "model", description: t("codingAgent.slashFallback.model"), argumentHint: "<provider/model>" },
	{ name: "scoped-models", description: t("codingAgent.slashFallback.scopedModels") },
	{ name: "export", description: t("codingAgent.slashFallback.export") },
	{ name: "import", description: t("codingAgent.slashFallback.import") },
	{ name: "share", description: t("codingAgent.slashFallback.share") },
	{ name: "copy", description: t("codingAgent.slashFallback.copy") },
	{ name: "name", description: t("codingAgent.slashFallback.name") },
	{ name: "session", description: t("codingAgent.slashFallback.session") },
	{ name: "changelog", description: t("codingAgent.slashFallback.changelog") },
	{ name: "hotkeys", description: t("codingAgent.slashFallback.hotkeys") },
	{ name: "fork", description: t("codingAgent.slashFallback.fork") },
	{ name: "clone", description: t("codingAgent.slashFallback.clone") },
	{ name: "tree", description: t("codingAgent.slashFallback.tree") },
	{ name: "trust", description: t("codingAgent.slashFallback.trust") },
	{ name: "login", description: t("codingAgent.slashFallback.login"), argumentHint: "<provider>" },
	{ name: "logout", description: t("codingAgent.slashFallback.logout") },
	{ name: "new", description: t("codingAgent.slashFallback.newSession") },
	{ name: "compact", description: t("codingAgent.slashFallback.compact") },
	{ name: "resume", description: t("codingAgent.slashFallback.resume") },
	{ name: "reload", description: t("codingAgent.slashFallback.reload") },
	{ name: "quit", description: t("codingAgent.slashFallback.quit", { appName: APP_NAME }) },
];
