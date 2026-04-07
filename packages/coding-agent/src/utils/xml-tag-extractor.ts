export interface XmlTagExtractor {
	push(delta: string): void;
	end(): Record<string, string>;
}

interface XmlTagExtractorState {
	buffer: string;
	currentTag: string | null;
	collected: Record<string, string>;
}

export function createXmlTagExtractor(tagNames: string[]): XmlTagExtractor {
	const tags = new Set(tagNames.map((name) => name.toLowerCase()));
	const state: XmlTagExtractorState = {
		buffer: "",
		currentTag: null,
		collected: {},
	};

	for (const tagName of tags) {
		state.collected[tagName] = "";
	}

	function push(delta: string): void {
		state.buffer += delta;

		while (state.buffer.length > 0) {
			if (state.currentTag === null) {
				const openIndex = state.buffer.indexOf("<");
				if (openIndex < 0) {
					state.buffer = "";
					return;
				}

				if (openIndex > 0) {
					state.buffer = state.buffer.slice(openIndex);
				}

				const closeIndex = state.buffer.indexOf(">");
				if (closeIndex < 0) {
					return;
				}

				const rawTag = state.buffer.slice(1, closeIndex).trim();
				state.buffer = state.buffer.slice(closeIndex + 1);

				if (rawTag.startsWith("/")) {
					continue;
				}

				const tagName = rawTag.split(/[\s/>]/, 1)[0]?.toLowerCase() ?? "";
				if (!tags.has(tagName)) {
					continue;
				}

				state.currentTag = tagName;
				continue;
			}

			const closingPrefix = `</${state.currentTag}`;
			const lowerBuffer = state.buffer.toLowerCase();
			const closingIndex = lowerBuffer.indexOf(closingPrefix);

			if (closingIndex < 0) {
				const keep = Math.min(state.buffer.length, Math.max(0, closingPrefix.length - 1));
				const flushUntil = state.buffer.length - keep;
				if (flushUntil > 0) {
					state.collected[state.currentTag] += state.buffer.slice(0, flushUntil);
					state.buffer = state.buffer.slice(flushUntil);
				}
				return;
			}

			state.collected[state.currentTag] += state.buffer.slice(0, closingIndex);
			const tagEndIndex = state.buffer.indexOf(">", closingIndex);
			if (tagEndIndex < 0) {
				state.buffer = state.buffer.slice(closingIndex);
				return;
			}

			state.buffer = state.buffer.slice(tagEndIndex + 1);
			state.currentTag = null;
		}
	}

	function end(): Record<string, string> {
		const result: Record<string, string> = {};
		for (const tagName of tags) {
			result[tagName] = state.collected[tagName].trim();
		}
		return result;
	}

	return { push, end };
}
