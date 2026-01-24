import { marked, type Token, type Tokens } from "marked";

function isListToken(token: Token): token is Tokens.List {
	return token.type === "list" && Array.isArray((token as Tokens.List).items);
}

function hasInlineTokens(token: Token): token is Token & { tokens: Token[] } {
	return "tokens" in token && Array.isArray((token as { tokens?: unknown }).tokens);
}

function containsHtmlToken(tokens: readonly Token[]): boolean {
	for (const token of tokens) {
		if (token.type === "html") return true;

		if (hasInlineTokens(token) && containsHtmlToken(token.tokens)) {
			return true;
		}

		if (isListToken(token)) {
			for (const item of token.items) {
				if (Array.isArray(item.tokens) && containsHtmlToken(item.tokens)) {
					return true;
				}
			}
		}
	}

	return false;
}

/**
 * Returns true if `marked` would produce any HTML tokens (block or inline)
 * for the given text.
 *
 * This is useful when callers want to auto-escape / fence HTML/XML-ish input
 * before rendering markdown in environments that can't render HTML.
 */
export function containsMarkdownHtmlTokens(text: string): boolean {
	// Keep behavior aligned with Markdown component rendering.
	const normalizedText = text.replace(/\t/g, "   ");
	const tokens = marked.lexer(normalizedText);
	return containsHtmlToken(tokens);
}
