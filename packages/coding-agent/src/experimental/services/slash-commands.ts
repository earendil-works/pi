import { type Context, defineService } from "@earendil-works/chord";
import type { AgentOperationResponse, AgentQueueResponse } from "./agent-controller.ts";

export interface SlashCommandCompletion {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

export type SlashCommandRunResult = AgentOperationResponse | AgentQueueResponse | undefined;

export interface SlashCommandContribution {
	readonly name: string;
	readonly description?: string;
	readonly argumentHint?: string;
	getArgumentCompletions?(
		argumentPrefix: string,
	): readonly SlashCommandCompletion[] | null | Promise<readonly SlashCommandCompletion[] | null>;
	run(args: string, context: Context): SlashCommandRunResult | Promise<SlashCommandRunResult>;
}

export interface SlashCommands {
	register(command: SlashCommandContribution): () => void;
	/** Stage a same-name replacement while the previous facet generation retires. */
	replace(command: SlashCommandContribution): () => void;
	list(): readonly SlashCommandContribution[];
	subscribe(listener: (commands: readonly SlashCommandContribution[]) => void): () => void;
}

export const SlashCommands = defineService<SlashCommands>("pi.local.slash-commands", { local: true });
