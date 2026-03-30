export const MAX_MAIN_MESSAGE_LENGTH = 35000;
export const MAX_THREAD_MESSAGE_LENGTH = 20000;
export const MAIN_OVERFLOW_NOTE = "\n\n_(continued in thread)_";
export const TRUNCATION_NOTE = "\n\n_(message truncated, ask me to elaborate on specific parts)_";
export const THREAD_TRUNCATION_NOTE = "\n\n_(truncated)_";

export function truncateSlackText(text: string, maxLength: number, suffix: string): string {
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.substring(0, maxLength - suffix.length)}${suffix}`;
}

export function splitSlackMessage(text: string, maxLength: number): string[] {
	if (text.length <= maxLength) {
		return [text];
	}

	const parts: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		parts.push(remaining.slice(0, maxLength));
		remaining = remaining.slice(maxLength);
	}
	return parts;
}

export function splitFinalSlackReply(text: string): { mainText: string; overflowParts: string[] } {
	if (text.length <= MAX_MAIN_MESSAGE_LENGTH) {
		return {
			mainText: text,
			overflowParts: [],
		};
	}

	const mainText = `${text.slice(0, MAX_MAIN_MESSAGE_LENGTH - MAIN_OVERFLOW_NOTE.length)}${MAIN_OVERFLOW_NOTE}`;
	const overflowText = text.slice(MAX_MAIN_MESSAGE_LENGTH - MAIN_OVERFLOW_NOTE.length);
	return {
		mainText,
		overflowParts: splitSlackMessage(overflowText, MAX_THREAD_MESSAGE_LENGTH),
	};
}

export async function publishSplitFinalSlackReply({
	text,
	updateMainMessage,
	postInThread,
}: {
	text: string;
	updateMainMessage: (text: string) => Promise<void>;
	postInThread: (text: string) => Promise<void>;
}): Promise<{ mainText: string; overflowParts: string[] }> {
	const result = splitFinalSlackReply(text);
	await updateMainMessage(result.mainText);
	for (const overflowPart of result.overflowParts) {
		await postInThread(overflowPart);
	}
	return result;
}
