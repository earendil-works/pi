import type { SpanAttributes, StoredSpan } from "./index.ts";

function formatAttributes(attributes: Readonly<SpanAttributes> = {}): string {
	return Object.entries(attributes)
		.map(([key, value]) => ` ${key}=${JSON.stringify(value)}`)
		.join("");
}

/** Render stored spans as a chronological forest, treating absent parents as roots. */
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
			if (span.status.error !== undefined) error += ` ${span.status.error.name}: ${span.status.error.message}`;
		}
		lines.push(
			`${indent}${span.name}${formatAttributes(span.attributes)} (${span.endedMs - span.startedMs}ms)${error}`,
		);
		for (const event of span.events) {
			lines.push(`${indent}  · ${event.name}${formatAttributes(event.attributes)} (+${event.timeMs}ms)`);
		}
		for (const link of span.links) {
			lines.push(`${indent}  → link trace ${link.traceId} span ${link.spanId}${formatAttributes(link.attributes)}`);
		}
		const descendants = children.get(span.id) ?? [];
		for (let index = descendants.length - 1; index >= 0; index--) {
			pending.push({ span: descendants[index]!, depth: depth + 1 });
		}
	}
	return lines.join("\n");
}
