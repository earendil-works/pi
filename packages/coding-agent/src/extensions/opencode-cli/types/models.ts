import type { ThinkingLevelMap } from "@earendil-works/pi-ai";

export type ModelCost = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
};

export type OpenCodeModelInfo = {
	id: string;
	name: string;
	reasoning: boolean;
	image: boolean;
	contextWindow: number;
	maxTokens: number;
	cost: ModelCost;
	/** True when `cost` was read from discovery metadata rather than defaulted. */
	costFromMetadata?: boolean;
	status?: string;
	thinkingLevelMap?: ThinkingLevelMap;
};
