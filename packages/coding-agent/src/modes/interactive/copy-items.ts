import { Marked } from "@earendil-works/pi-tui";

export interface CopyItem {
	kind: "code" | "quote" | "whole";
	label: string;
	text: string;
}

const markdownParser = new Marked();

/** Extract code blocks and blockquotes, followed by the unmodified whole response. */
export function getCopyItems(text: string): CopyItem[] {
	const code: CopyItem[] = [];
	const quotes: CopyItem[] = [];
	markdownParser.walkTokens(markdownParser.lexer(text), (token) => {
		if (token.type === "code") {
			const language = token.lang?.trim().split(/\s+/, 1)[0];
			code.push({
				kind: "code",
				label: `Code ${code.length + 1}${language ? ` · ${language}` : ""}`,
				text: token.text,
			});
		} else if (token.type === "blockquote") {
			quotes.push({ kind: "quote", label: `Quote ${quotes.length + 1}`, text: token.text });
		}
	});
	return [...code, ...quotes, { kind: "whole", label: "Whole response", text }];
}
