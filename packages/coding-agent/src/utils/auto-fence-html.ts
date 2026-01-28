import { containsMarkdownHtmlTokens } from "@kennyfrc/mu-tui";

function getMaxBacktickRun(text: string): number {
	let maxRun = 0;
	let currentRun = 0;

	for (let i = 0; i < text.length; i++) {
		if (text[i] === "`") {
			currentRun++;
			if (currentRun > maxRun) {
				maxRun = currentRun;
			}
		} else {
			currentRun = 0;
		}
	}

	return maxRun;
}

/**
 * If the text contains HTML/XML-like tags that markdown would tokenize as HTML,
 * wrap the entire text in a fenced code block.
 */
export function autoFenceHtmlInMarkdown(text: string): string {
	if (!containsMarkdownHtmlTokens(text)) return text;

	// Choose a fence that can't be closed by backticks inside the content.
	const maxRun = getMaxBacktickRun(text);
	const fenceLen = Math.max(3, maxRun + 1);
	const fence = "`".repeat(fenceLen);

	return `${fence}\n${text}\n${fence}`;
}
