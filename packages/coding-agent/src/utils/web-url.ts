import { replaceControlCharacters } from "@earendil-works/pi-tui";

/**
 * The `http:` or `https:` URL `value` names, normalized, or undefined. The shared launcher also opens files and custom
 * protocols, so login only opens web URLs. Normalizing percent-encodes control characters, which would otherwise end a
 * terminal hyperlink early.
 */
export function webUrl(value: string): string | undefined {
	if (!URL.canParse(value)) return undefined;
	const url = new URL(value);
	return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
}

/**
 * `value` normalized as a web URL, else with control characters replaced: an untrusted string printed as is could end a
 * hyperlink early or send its own escape sequences to the terminal.
 */
export function displayUrl(value: string): string {
	return webUrl(value) ?? replaceControlCharacters(value);
}
