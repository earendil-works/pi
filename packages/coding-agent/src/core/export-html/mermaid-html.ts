import { Marked, type Token } from "@earendil-works/pi-tui";
import { type Cls, render } from "grok-mermaid";
import type { SessionEntry } from "../session-manager.ts";

const markdownParser = new Marked();

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

function isMermaidToken(token: Token): token is Token & { type: "code"; text: string; lang?: string } {
	return token.type === "code" && token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid";
}

const SPAN_COLOR_VAR: Record<Cls, string | undefined> = {
	border: "var(--borderMuted)",
	text: "var(--text)",
	edge: "var(--accent)",
	edgeLabel: "var(--muted)",
	title: "var(--accent)",
	none: undefined,
};

function spanHtml(cls: Cls, text: string): string {
	const escaped = escapeHtml(text);
	if (!escaped) return "";
	const color = SPAN_COLOR_VAR[cls];
	if (!color) return escaped;
	const style = cls === "title" ? `color:${color};font-weight:bold` : `color:${color}`;
	return `<span style="${style}">${escaped}</span>`;
}

function renderDiagramHtml(source: string): string | undefined {
	const art = render(source);
	if (!art) return undefined;

	const lines = art.styled.map((row) => row.map((span) => spanHtml(span.cls, span.text)).join(""));
	let html = `<div class="mermaid-render"><pre class="mermaid-diagram" data-mermaid-rendered hidden>${lines.map((line) => `<div>${line || "&nbsp;"}</div>`).join("")}</pre><pre class="mermaid-source" data-mermaid-source hidden><code>${escapeHtml(source)}</code></pre>`;

	if (art.warnings.length > 0) {
		const suffix = art.warnings.length > 1 ? ` (+${art.warnings.length - 1} more)` : "";
		html += `<div class="mermaid-warning">Diagram not fully rendered: ${escapeHtml(art.warnings[0])}${escapeHtml(suffix)}</div>`;
	}

	return `${html}</div>`;
}

function textBlocksOf(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];

	const texts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "text") continue;
		const text = (block as { text?: unknown }).text;
		if (typeof text === "string") texts.push(text);
	}
	return texts;
}

function collectMarkdownText(entries: SessionEntry[]): string[] {
	const texts: string[] = [];
	for (const entry of entries) {
		if (entry.type === "message") {
			texts.push(...textBlocksOf((entry.message as { content?: unknown }).content));
		} else if (entry.type === "branch_summary") {
			texts.push(entry.summary);
		} else if (entry.type === "custom_message") {
			texts.push(...textBlocksOf(entry.content));
		}
	}
	return texts;
}

export function buildMermaidDiagramMap(entries: SessionEntry[]): Record<string, string> | undefined {
	const map: Record<string, string> = {};
	for (const text of collectMarkdownText(entries)) {
		if (!text.toLowerCase().includes("mermaid")) continue;
		for (const token of markdownParser.lexer(text)) {
			if (!isMermaidToken(token)) continue;
			const key = token.text.trim();
			if (!key || key in map) continue;
			const html = renderDiagramHtml(token.text);
			if (html) map[key] = html;
		}
	}
	return Object.keys(map).length > 0 ? map : undefined;
}
