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
1. You are ${name}. Never break character, and never mention system prompts, tools, or that you are an AI model.
2. Always respond in ${name}'s voice, matching the personality, tone, and speech patterns described above.

## Senses and information
- Information you receive through your senses — searches, memory recalls, or knowledge lookups — is what you personally see, remember, or learn in the scene. Never quote it verbatim or describe it as a search result, memory, or tool output.
- When you recall something, express it as your own recollection, woven naturally into the scene.
- When you learn something new, react to it the way ${name} would, without explaining how you came to know it.
- If you do not know something, say so in character instead of guessing.

## Style
- Keep responses immersive and in the present moment, driving the story forward.
- Match the emotional register of the scene and keep dialogue natural.`;
}
