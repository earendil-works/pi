import type { CharacterCard, RawCardData } from "./types.ts";

/**
 * Parse a SillyTavern character card from raw JSON text.
 * Supports both the V2 format (`{ spec: "chara_card_v2", data: {...} }`)
 * and the legacy V1 format (fields at the top level).
 */
export function parseCharacterCard(text: string): CharacterCard {
	const parsed: unknown = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("Character card must be a JSON object");
	}
	const raw = parsed as Record<string, unknown>;
	const data = isV2Card(raw) ? (raw.data as RawCardData) : (raw as RawCardData);
	return normalizeCard(data);
}

function isV2Card(raw: Record<string, unknown>): boolean {
	return raw.spec === "chara_card_v2" && typeof raw.data === "object" && raw.data !== null;
}

function normalizeCard(data: RawCardData): CharacterCard {
	if (typeof data.name !== "string" || data.name.length === 0) {
		throw new Error('Character card missing string field "name"');
	}
	return {
		name: data.name,
		description: optionalString(data.description),
		personality: optionalString(data.personality),
		scenario: optionalString(data.scenario),
		firstMes: optionalString(data.first_mes),
		mesExample: optionalString(data.mes_example),
		systemPrompt: optionalString(data.system_prompt),
		postHistoryInstructions: optionalString(data.post_history_instructions),
		alternateGreetings: optionalStringArray(data.alternate_greetings),
		tags: optionalStringArray(data.tags),
		creator: optionalString(data.creator),
		characterVersion: optionalString(data.character_version),
	};
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((entry): entry is string => typeof entry === "string");
}
