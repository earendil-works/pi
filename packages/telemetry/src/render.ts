import type { SpanAttributes, StoredSpan } from "./index.ts";

// C0 and C1 control characters and DEL: a stored id, name or message may come from another process (a carrier), so
// none reaches a terminal or a viewer raw.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** `text` with every control character written as a `\uXXXX` escape. */
function escaped(text: string): string {
	return text.replace(CONTROL, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** `ms` rounded to the microsecond, as the adapters record span times. */
function microseconds(ms: number): number {
	return Math.round(ms * 1000) / 1000;
}

function formatAttributes(attributes: Readonly<SpanAttributes> = {}): string {
	return Object.entries(attributes)
		.map(([key, value]) => ` ${escaped(key)}=${JSON.stringify(value)}`)
		.join("");
}

/**
 * Render stored spans as a chronological forest, treating absent parents as roots. Lengths of time are milliseconds to
 * the microsecond. Control characters in ids, names, attribute keys and error messages are escaped (attribute values
 * are JSON).
 */
export function renderTrace(spans: readonly StoredSpan[]): string {
	const byId = new Map(spans.map((span) => [span.id, span]));
	const roots: StoredSpan[] = [];
	const children = new Map<string, StoredSpan[]>();
	for (const span of [...byId.values()].sort((left, right) => left.startedMs - right.startedMs)) {
		if (span.parentId === undefined || !byId.has(span.parentId)) {
			roots.push(span);
		} else {
			const siblings = children.get(span.parentId);
			if (siblings === undefined) children.set(span.parentId, [span]);
			else siblings.push(span);
		}
	}

	const lines: string[] = [];
	const pending = roots.reverse().map((span) => ({ span, depth: 0 }));
	while (pending.length > 0) {
		const { span, depth } = pending.pop()!;
		const indent = "  ".repeat(depth);
		let error = "";
		if (span.status.status === "error") {
			error = " error";
			if (span.status.error !== undefined) {
				error += ` ${escaped(span.status.error.name)}: ${escaped(span.status.error.message)}`;
			}
		}
		lines.push(
			`${indent}${escaped(span.name)}${formatAttributes(span.attributes)} (${microseconds(span.endedMs - span.startedMs)}ms)${error}`,
		);
		for (const event of span.events) {
			lines.push(
				`${indent}  · ${escaped(event.name)}${formatAttributes(event.attributes)} (+${microseconds(event.timeMs)}ms)`,
			);
		}
		for (const link of span.links) {
			const ids = `trace ${escaped(link.traceId)} span ${escaped(link.spanId)}`;
			lines.push(`${indent}  → link ${ids}${formatAttributes(link.attributes)}`);
		}
		const descendants = children.get(span.id) ?? [];
		for (let index = descendants.length - 1; index >= 0; index--) {
			pending.push({ span: descendants[index]!, depth: depth + 1 });
		}
	}
	return lines.join("\n");
}
