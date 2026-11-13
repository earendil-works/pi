// The conversation's voice against the speech service's offer: which engine, voice and language a choice means when
// the service no longer offers part of it (its defaults fill in), and how the Voice sheet lists them.
import type { VoiceSettings } from "./engine.ts";
import type { TtsEngine, Voices as VoiceConfig } from "./protocol.ts";

/**
 * The engine, voice and language in use: the given ones while the service offers them, else its default (an engine
 * kept, but a voice or language it does not have, falls back to that engine's default or first; switching to an engine
 * with one language, Pocket's English, resets the language).
 */
export function resolveVoice(
	config: VoiceConfig | undefined,
	settings: VoiceSettings,
): { engine: TtsEngine | undefined; voice: string; language: string | undefined } {
	if (!config) return { engine: undefined, voice: settings.voice, language: settings.language };
	const engine =
		config.engines.find((candidate) => candidate.id === settings.engine) ??
		config.engines.find((candidate) => candidate.id === config.default.engine) ??
		config.engines[0];
	const has = (id: string) => engine?.voices.some((voice) => voice.id === id) ?? false;
	const voice = has(settings.voice)
		? settings.voice
		: engine?.id === config.default.engine && has(config.default.voice)
			? config.default.voice
			: (engine?.voices[0]?.id ?? "");
	// The language likewise: the chosen one while the engine speaks it, else the service's default (for its default
	// engine) or the engine's.
	const speaks = (id: string | undefined) =>
		id ? (engine?.languages?.some((option) => option.id === id) ?? false) : false;
	const language = speaks(settings.language)
		? settings.language
		: engine?.id === config.default.engine && speaks(config.default.language)
			? config.default.language
			: engine?.defaultLanguage;
	return { engine, voice, language };
}

/** An engine's languages for the picker: English and Deutsch first, then the service's order. */
export function languagesOf(engine: TtsEngine | undefined): { id: string; name: string }[] {
	const all = engine?.languages ?? [];
	const first = ["en", "de"].flatMap((id) => all.filter((option) => option.id === id));
	return [...first, ...all.filter((option) => !first.includes(option))];
}

/** What a voice choice means against the service: valid engine, voice and language IDs. */
export const resolved = (config: VoiceConfig | undefined, settings: VoiceSettings): VoiceSettings => {
	const { engine, voice, language } = resolveVoice(config, settings);
	return { engine: engine?.id ?? settings.engine, voice, speed: settings.speed, ...(language ? { language } : {}) };
};

/** An engine's short name: its ID capitalized ("Pocket"); the service's full name ("Pocket TTS (Kyutai)") is its title. */
export const engineLabel = (engine: TtsEngine): string => engine.id.charAt(0).toUpperCase() + engine.id.slice(1);
