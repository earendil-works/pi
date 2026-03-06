export function formatQueuedMessagePreview(raw: string, kind: "by-end" | "next"): string {
	const prefix = kind === "next" ? "↳ Queued next: " : "↳ Queued: ";
	const continuationPrefix = " ".repeat(prefix.length);
	const lines = raw.split("\n");

	return lines.map((line, index) => `${index === 0 ? prefix : continuationPrefix}${line}`).join("\n");
}
