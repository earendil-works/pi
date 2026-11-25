// The `word_count` tool: what the model sees (name, description, parameters) and what it does. Nothing here says how
// a call looks: that is the web and TUI facets' business.
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";

/** What a call's result keeps for the UI, beside the text the model reads: the counts. */
export type WordCountDetails = { words: number; lines: number };

export function countWords(text: string): WordCountDetails {
	return { words: text.split(/\s+/).filter(Boolean).length, lines: text.split("\n").length };
}

export const wordCountExtension = defineExtension({
	name: "p2-word-count",
	tools: [
		defineTool({
			name: "word_count",
			description: "Count the words and lines of a text.",
			parameters: obj({ text: str() }),
			replay: "safe",
			execute: async (args) => {
				if (!args.text.trim()) throw new Error("Nothing to count: the text is empty.");
				const details = countWords(args.text);
				return {
					output: [{ type: "text", text: `${details.words} words, ${details.lines} lines` }],
					details,
				};
			},
		}),
	],
});
