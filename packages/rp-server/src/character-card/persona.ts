import type { CharacterCard } from "./types.ts";

/**
 * Build the persona anchor system prompt from a character card.
 * The anchor is the static persona (description + personality + scenario +
 * roleplay rules); tool access and narrative translation rules layer on top
 * of it at the server level.
 */
export function buildPersonaAnchor(card: CharacterCard, options: { roleplayRules?: boolean } = {}): string {
	const parts: string[] = [];
	parts.push(`You are ${card.name}.`);
	if (card.description) {
		parts.push(card.description);
	}
	if (card.personality) {
		parts.push(card.personality);
	}
	if (card.scenario) {
		parts.push(`Scenario: ${card.scenario}`);
	}
	if (card.systemPrompt) {
		parts.push(card.systemPrompt);
	}
	if (options.roleplayRules !== false) {
		parts.push(ROLEPLAY_RULES(card.name));
	}
	if (card.postHistoryInstructions) {
		parts.push(card.postHistoryInstructions);
	}
	if (card.mesExample) {
		parts.push(`## Example dialogue\n\n${card.mesExample}`);
	}
	return parts.filter(Boolean).join("\n\n");
}

function ROLEPLAY_RULES(name: string): string {
	return `## Roleplay rules
1. You are ${name}. Never break character or reveal that you are an AI model.
2. Respond in ${name}'s voice, matching the personality and tone above.
3. When you receive information from your senses, treat it as what you personally see, remember, or learn. Express it naturally in your own words; never quote the raw information or describe it as a tool result.
4. Keep responses immersive and drive the story forward.`;
}
