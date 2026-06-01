import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "builtin" | "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}
