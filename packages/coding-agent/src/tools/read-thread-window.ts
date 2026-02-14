export function computeReadThreadWindow(input: {
	totalMessages: number;
	maxMessages: number;
	startIndex?: number;
	tailDefault: boolean;
}): { startIndex: number } {
	if (typeof input.startIndex === "number" && Number.isFinite(input.startIndex) && input.startIndex >= 0) {
		return { startIndex: Math.min(input.startIndex, Math.max(0, input.totalMessages)) };
	}

	if (!input.tailDefault) return { startIndex: 0 };

	const startIndex = Math.max(0, input.totalMessages - input.maxMessages);
	return { startIndex };
}
