// What voice mode reads aloud of a streaming answer: its Markdown as sentences of plain text. `SpeechChunker` is fed the
// whole text so far and returns the sentences completed since the last call; code blocks and tables are skipped.

/** A sentence end: punctuation (with closing quotes or brackets) followed by whitespace. */
const SENTENCE_END = /[.!?…]+["')\]]*(?=\s)/g;
/** Common abbreviations whose period does not end a sentence. */
const ABBREVIATION = /\b(?:e\.g|i\.e|etc|vs|approx|e\.g\.|i\.e\.|Mr|Mrs|Ms|Dr|No|cf)\.$/i;

/** Plain text of one Markdown sentence or line; empty when nothing in it is worth saying. */
export function speakable(markdown: string): string {
	let text = markdown.trim();
	if (/^\|/.test(text) || /^[-*_=]{3,}$/.test(text)) return "";
	text = text
		.replace(/^#{1,6}\s+/, "")
		.replace(/^>\s?/, "")
		.replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/<https?:\/\/[^>]+>/g, "a link")
		.replace(/https?:\/\/\S+/g, "a link")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
		.replace(/~~(.+?)~~/g, "$1")
		.replace(/[*#`|]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return /[\p{L}\p{N}]/u.test(text) ? text : "";
}

export class SpeechChunker {
	#position = 0;
	#fence = false;

	/**
	 * The sentences of `text` (everything so far; it only grows) completed since the last call. With `final`, the rest
	 * too: the answer is complete.
	 */
	push(text: string, final = false): string[] {
		const out: string[] = [];
		const emit = (raw: string) => {
			const sentence = speakable(raw);
			if (sentence) out.push(sentence);
		};
		while (this.#position < text.length) {
			const position = this.#position;
			const newline = text.indexOf("\n", position);
			const complete = newline !== -1;
			const lineEnd = complete ? newline : text.length;
			if (position === 0 || text[position - 1] === "\n") {
				const line = text.slice(position, lineEnd).trim();
				if (line.startsWith("```") || line.startsWith("~~~")) {
					if (!complete && !final) break;
					this.#fence = !this.#fence;
					this.#position = complete ? newline + 1 : text.length;
					continue;
				}
			}
			if (this.#fence) {
				if (!complete && !final) break;
				this.#position = complete ? newline + 1 : text.length;
				continue;
			}
			const end = this.#sentenceEnd(text, position, lineEnd);
			if (end !== undefined) {
				emit(text.slice(position, end));
				this.#position = end;
				while (this.#position < lineEnd && /\s/.test(text[this.#position]!)) this.#position++;
				continue;
			}
			if (complete) {
				emit(text.slice(position, newline));
				this.#position = newline + 1;
				continue;
			}
			if (final) {
				emit(text.slice(position));
				this.#position = text.length;
			}
			break;
		}
		return out;
	}

	/** Where the first sentence from `start` ends within its line, outside inline code; undefined if none yet. */
	#sentenceEnd(text: string, start: number, lineEnd: number): number | undefined {
		const line = text.slice(start, lineEnd);
		SENTENCE_END.lastIndex = 0;
		for (let match = SENTENCE_END.exec(line); match; match = SENTENCE_END.exec(line)) {
			const end = match.index + match[0].length;
			const before = line.slice(0, end);
			// Inside inline code (an odd number of backticks before it), or an abbreviation: not an end.
			if ((before.match(/`/g)?.length ?? 0) % 2 === 1 || ABBREVIATION.test(before)) continue;
			// A list number ("1. ") at the start of the line is not a sentence.
			if (start === 0 || text[start - 1] === "\n") {
				if (/^\s*\d+[.)]$/.test(before)) continue;
			}
			return start + end;
		}
		return undefined;
	}
}

/** Utterances that stop the agent and its speech instead of being sent. */
const STOP = new Set([
	"stop",
	"stop it",
	"stop stop",
	"be quiet",
	"quiet",
	"shut up",
	"cancel",
	"never mind",
	"nevermind",
]);

export function isStopCommand(text: string): boolean {
	const normalized = text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	return (
		STOP.has(normalized) || /^(?:ok(?:ay)?|please|hey) stop$/.test(normalized) || /^stop please$/.test(normalized)
	);
}
