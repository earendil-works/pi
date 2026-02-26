import { parse as partialParse } from "partial-json";

function escapeControlCharsInJsonStrings(input: string): string {
	let output = "";
	let inString = false;
	let escaped = false;

	for (const char of input) {
		const code = char.charCodeAt(0);

		if (!inString) {
			if (char === '"') {
				inString = true;
			}
			output += char;
			continue;
		}

		if (escaped) {
			output += char;
			escaped = false;
			continue;
		}

		if (char === "\\") {
			output += char;
			escaped = true;
			continue;
		}

		if (char === '"') {
			inString = false;
			output += char;
			continue;
		}

		if (code >= 0x20) {
			output += char;
			continue;
		}

		switch (char) {
			case "\b":
				output += "\\b";
				break;
			case "\f":
				output += "\\f";
				break;
			case "\n":
				output += "\\n";
				break;
			case "\r":
				output += "\\r";
				break;
			case "\t":
				output += "\\t";
				break;
			default:
				output += `\\u${code.toString(16).padStart(4, "0")}`;
				break;
		}
	}

	return output;
}

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
export function parseStreamingJson<T = any>(partialJson: string | undefined): T {
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	// Try standard parsing first (fastest for complete JSON)
	try {
		return JSON.parse(partialJson) as T;
	} catch {
		// Some models emit raw control characters (e.g., literal newlines) inside JSON strings.
		// Repair those in-string characters and retry before partial parsing.
		try {
			const repairedJson = escapeControlCharsInJsonStrings(partialJson);
			if (repairedJson !== partialJson) {
				try {
					return JSON.parse(repairedJson) as T;
				} catch {
					const repairedPartial = partialParse(repairedJson);
					return (repairedPartial ?? {}) as T;
				}
			}
		} catch {
			// Ignore repair path failures and continue to legacy partial parsing.
		}

		// Try partial-json for incomplete JSON (existing behavior)
		try {
			const result = partialParse(partialJson);
			return (result ?? {}) as T;
		} catch {
			// If all parsing fails, return empty object
			return {} as T;
		}
	}
}
