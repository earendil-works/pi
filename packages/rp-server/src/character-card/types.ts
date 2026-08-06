export interface CharacterCard {
	name: string;
	description?: string;
	personality?: string;
	scenario?: string;
	firstMes?: string;
	mesExample?: string;
	systemPrompt?: string;
	postHistoryInstructions?: string;
	alternateGreetings: string[];
	tags: string[];
	creator?: string;
	characterVersion?: string;
}

export interface RawCardData {
	name?: unknown;
	description?: unknown;
	personality?: unknown;
	scenario?: unknown;
	first_mes?: unknown;
	mes_example?: unknown;
	system_prompt?: unknown;
	post_history_instructions?: unknown;
	alternate_greetings?: unknown;
	tags?: unknown;
	creator?: unknown;
	character_version?: unknown;
}
