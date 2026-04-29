import type { AgentState } from "@mariozechner/pi-agent-core";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { Marked, type Token } from "marked";
import { basename, join } from "path";
import { APP_NAME, getExportTemplateDir } from "../../config.js";
import { createHtmlSyntaxHighlighter } from "../../modes/interactive/theme/syntax-highlighting.js";
import {
	getLanguageFromPath,
	getResolvedThemeColors,
	getResolvedThemeDiffColors,
	getThemeExportColors,
	getThemeSyntaxTheme,
} from "../../modes/interactive/theme/theme.js";
import type { ToolDefinition } from "../extensions/types.js";
import type { SessionEntry } from "../session-manager.js";
import { SessionManager } from "../session-manager.js";

/**
 * Interface for rendering custom tools to HTML.
 * Used by agent-session to pre-render extension tool output.
 */
export interface ToolHtmlRenderer {
	/** Render a tool call to HTML. Returns undefined if tool has no custom renderer. */
	renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined;
	/** Render a tool result to HTML. Returns collapsed/expanded or undefined if tool has no custom renderer. */
	renderResult(
		toolCallId: string,
		toolName: string,
		result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
		details: unknown,
		isError: boolean,
	): { collapsed?: string; expanded?: string } | undefined;
}

/** Pre-rendered HTML for a custom tool call and result */
interface RenderedToolHtml {
	callHtml?: string;
	resultHtmlCollapsed?: string;
	resultHtmlExpanded?: string;
}

interface HighlightRequest {
	code: string;
	lang: string;
}

const markdownParser = new Marked();

export interface ExportOptions {
	outputPath?: string;
	themeName?: string;
	/** Optional tool renderer for custom tools */
	toolRenderer?: ToolHtmlRenderer;
}

/** Parse a color string to RGB values. Supports hex (#RRGGBB) and rgb(r,g,b) formats. */
function parseColor(color: string): { r: number; g: number; b: number } | undefined {
	const hexMatch = color.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
	if (hexMatch) {
		return {
			r: Number.parseInt(hexMatch[1], 16),
			g: Number.parseInt(hexMatch[2], 16),
			b: Number.parseInt(hexMatch[3], 16),
		};
	}
	const rgbMatch = color.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
	if (rgbMatch) {
		return {
			r: Number.parseInt(rgbMatch[1], 10),
			g: Number.parseInt(rgbMatch[2], 10),
			b: Number.parseInt(rgbMatch[3], 10),
		};
	}
	return undefined;
}

/** Calculate relative luminance of a color (0-1, higher = lighter). */
function getLuminance(r: number, g: number, b: number): number {
	const toLinear = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** Adjust color brightness. Factor > 1 lightens, < 1 darkens. */
function adjustBrightness(color: string, factor: number): string {
	const parsed = parseColor(color);
	if (!parsed) return color;
	const adjust = (c: number) => Math.min(255, Math.max(0, Math.round(c * factor)));
	return `rgb(${adjust(parsed.r)}, ${adjust(parsed.g)}, ${adjust(parsed.b)})`;
}

/** Derive export background colors from a base color (e.g., userMessageBg). */
function deriveExportColors(baseColor: string): { pageBg: string; cardBg: string; infoBg: string } {
	const parsed = parseColor(baseColor);
	if (!parsed) {
		return {
			pageBg: "rgb(24, 24, 30)",
			cardBg: "rgb(30, 30, 36)",
			infoBg: "rgb(60, 55, 40)",
		};
	}

	const luminance = getLuminance(parsed.r, parsed.g, parsed.b);
	const isLight = luminance > 0.5;

	if (isLight) {
		return {
			pageBg: adjustBrightness(baseColor, 0.96),
			cardBg: baseColor,
			infoBg: `rgb(${Math.min(255, parsed.r + 10)}, ${Math.min(255, parsed.g + 5)}, ${Math.max(0, parsed.b - 20)})`,
		};
	}
	return {
		pageBg: adjustBrightness(baseColor, 0.7),
		cardBg: adjustBrightness(baseColor, 0.85),
		infoBg: `rgb(${Math.min(255, parsed.r + 20)}, ${Math.min(255, parsed.g + 15)}, ${parsed.b})`,
	};
}

/**
 * Generate CSS custom property declarations from theme colors.
 */
function generateThemeVars(themeName?: string): string {
	const colors = getResolvedThemeColors(themeName);
	const lines: string[] = [];
	for (const [key, value] of Object.entries(colors)) {
		lines.push(`--${key}: ${value};`);
	}
	for (const [key, value] of Object.entries(getResolvedThemeDiffColors(themeName))) {
		lines.push(`--${key}: ${value};`);
	}

	// Use explicit theme export colors if available, otherwise derive from userMessageBg
	const themeExport = getThemeExportColors(themeName);
	const userMessageBg = colors.userMessageBg || "#343541";
	const derivedColors = deriveExportColors(userMessageBg);

	lines.push(`--exportPageBg: ${themeExport.pageBg ?? derivedColors.pageBg};`);
	lines.push(`--exportCardBg: ${themeExport.cardBg ?? derivedColors.cardBg};`);
	lines.push(`--exportInfoBg: ${themeExport.infoBg ?? derivedColors.infoBg};`);

	return lines.join("\n      ");
}

function highlightKey(code: string, lang: string | undefined): string {
	return `${lang ?? ""}\0${code}`;
}

function addHighlightRequest(requests: Map<string, HighlightRequest>, code: string, lang: string | undefined): void {
	if (!lang) return;
	const normalized = code.replace(/\t/g, "   ");
	requests.set(highlightKey(normalized, lang), { code: normalized, lang });
}

function collectMarkdownHighlights(text: string, requests: Map<string, HighlightRequest>): void {
	if (!text.trim()) return;
	const tokens = markdownParser.lexer(text);
	collectMarkdownTokenHighlights(tokens, requests);
}

function collectMarkdownTokenHighlights(tokens: Token[], requests: Map<string, HighlightRequest>): void {
	for (const token of tokens) {
		if (token.type === "code") {
			addHighlightRequest(requests, token.text, token.lang);
		}
		if ("tokens" in token && Array.isArray(token.tokens)) {
			collectMarkdownTokenHighlights(token.tokens, requests);
		}
		if ("items" in token && Array.isArray(token.items)) {
			for (const item of token.items) {
				if (typeof item === "object" && item !== null && "tokens" in item && Array.isArray(item.tokens)) {
					collectMarkdownTokenHighlights(item.tokens, requests);
				}
			}
		}
	}
}

function getTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n");
}

function getToolResultText(entry: SessionEntry): string | undefined {
	if (entry.type !== "message" || entry.message.role !== "toolResult") return undefined;
	return getTextContent(entry.message.content);
}

interface SessionData {
	header: ReturnType<SessionManager["getHeader"]>;
	entries: ReturnType<SessionManager["getEntries"]>;
	leafId: string | null;
	systemPrompt?: string;
	tools?: Array<Pick<ToolDefinition, "name" | "description" | "parameters">>;
	/** Pre-rendered HTML for custom tool calls/results, keyed by tool call ID */
	renderedTools?: Record<string, RenderedToolHtml>;
	/** Pre-highlighted code snippets for client-side rendering, keyed by language and source text. */
	highlightedCode?: Record<string, string>;
}

interface ToolCallBlockLike {
	type: "toolCall";
	id: string;
	name: string;
	arguments: unknown;
}

function isToolCallBlock(block: unknown): block is ToolCallBlockLike {
	return (
		typeof block === "object" &&
		block !== null &&
		"type" in block &&
		block.type === "toolCall" &&
		"id" in block &&
		typeof block.id === "string" &&
		"name" in block &&
		typeof block.name === "string"
	);
}

function getStringArg(value: unknown, keys: string[]): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	for (const key of keys) {
		if (key in value) {
			const candidate = (value as Record<string, unknown>)[key];
			if (typeof candidate === "string") return candidate;
		}
	}
	return undefined;
}

function getToolCallBlocks(entry: SessionEntry): ToolCallBlockLike[] {
	if (entry.type !== "message" || entry.message.role !== "assistant") return [];
	const content = entry.message.content;
	if (!Array.isArray(content)) return [];
	const blocks: ToolCallBlockLike[] = [];
	for (const block of content) {
		if (isToolCallBlock(block)) blocks.push(block);
	}
	return blocks;
}

function collectExpandableOutputHighlight(
	requests: Map<string, HighlightRequest>,
	text: string,
	maxLines: number,
	lang: string | undefined,
): void {
	if (!lang) return;
	const normalized = text.replace(/\t/g, "   ");
	const lines = normalized.split("\n");
	addHighlightRequest(requests, normalized, lang);
	if (lines.length > maxLines) {
		addHighlightRequest(requests, lines.slice(0, maxLines).join("\n"), lang);
	}
}

function parseDiffContent(line: string): string {
	return line.match(/^([+-\s])(\s*\d*)\s(.*)$/)?.[3] ?? line;
}

function collectDiffHighlight(
	requests: Map<string, HighlightRequest>,
	diffText: string,
	lang: string | undefined,
): void {
	if (!lang) return;
	const content = diffText
		.split("\n")
		.map(parseDiffContent)
		.map((line) => line.replace(/\t/g, "   "))
		.join("\n");
	addHighlightRequest(requests, content, lang);
}

function getToolResultDiff(entry: SessionEntry): string | undefined {
	if (entry.type !== "message" || entry.message.role !== "toolResult") return undefined;
	const details = entry.message.details;
	if (typeof details !== "object" || details === null || !("diff" in details)) return undefined;
	const diff = (details as { diff?: unknown }).diff;
	return typeof diff === "string" ? diff : undefined;
}

function collectHighlightRequests(sessionData: SessionData): Map<string, HighlightRequest> {
	const requests = new Map<string, HighlightRequest>();
	const toolResults = new Map<string, SessionEntry>();
	for (const entry of sessionData.entries) {
		if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId) {
			toolResults.set(entry.message.toolCallId, entry);
		}
	}

	for (const entry of sessionData.entries) {
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "user") {
				collectMarkdownHighlights(getTextContent(message.content), requests);
			} else if (message.role === "assistant" && Array.isArray(message.content)) {
				for (const block of message.content) {
					if (typeof block === "object" && block !== null && "type" in block && block.type === "text") {
						const text = "text" in block && typeof block.text === "string" ? block.text : "";
						collectMarkdownHighlights(text, requests);
					}
				}
			}
		} else if (entry.type === "branch_summary") {
			collectMarkdownHighlights(entry.summary, requests);
		} else if (entry.type === "custom_message" && entry.display) {
			collectMarkdownHighlights(
				typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content),
				requests,
			);
		}

		for (const call of getToolCallBlocks(entry)) {
			const resultEntry = toolResults.get(call.id);
			const resultText = resultEntry ? getToolResultText(resultEntry) : undefined;
			if (call.name === "read" && resultText) {
				const filePath = getStringArg(call.arguments, ["file_path", "path"]);
				const lang = filePath ? getLanguageFromPath(filePath) : undefined;
				collectExpandableOutputHighlight(requests, resultText, 10, lang);
			} else if (call.name === "write") {
				const filePath = getStringArg(call.arguments, ["file_path", "path"]);
				const content = getStringArg(call.arguments, ["content"]);
				const lang = filePath ? getLanguageFromPath(filePath) : undefined;
				if (content) collectExpandableOutputHighlight(requests, content, 10, lang);
			} else if (call.name === "edit" && resultEntry) {
				const filePath = getStringArg(call.arguments, ["file_path", "path"]);
				const lang = filePath ? getLanguageFromPath(filePath) : undefined;
				const diff = getToolResultDiff(resultEntry);
				if (diff) collectDiffHighlight(requests, diff, lang);
			}
		}
	}
	return requests;
}

async function buildHighlightedCodeMap(
	sessionData: SessionData,
	themeName?: string,
): Promise<Record<string, string> | undefined> {
	const requests = collectHighlightRequests(sessionData);
	if (requests.size === 0) return undefined;
	const highlighter = await createHtmlSyntaxHighlighter(getThemeSyntaxTheme(themeName));
	try {
		const highlighted: Record<string, string> = {};
		for (const [key, request] of requests.entries()) {
			const html = await highlighter.highlight(request.code, request.lang);
			if (html !== undefined) highlighted[key] = html;
		}
		return Object.keys(highlighted).length > 0 ? highlighted : undefined;
	} finally {
		highlighter.dispose();
	}
}

/**
 * Core HTML generation logic shared by both export functions.
 */
async function generateHtml(sessionData: SessionData, themeName?: string): Promise<string> {
	const templateDir = getExportTemplateDir();
	const template = readFileSync(join(templateDir, "template.html"), "utf-8");
	const templateCss = readFileSync(join(templateDir, "template.css"), "utf-8");
	const templateJs = readFileSync(join(templateDir, "template.js"), "utf-8");
	const markedJs = readFileSync(join(templateDir, "vendor", "marked.min.js"), "utf-8");

	const themeVars = generateThemeVars(themeName);
	const colors = getResolvedThemeColors(themeName);
	const themeExport = getThemeExportColors(themeName);
	const derivedExportColors = deriveExportColors(colors.userMessageBg || "#343541");
	const bodyBg = themeExport.pageBg ?? derivedExportColors.pageBg;
	const containerBg = themeExport.cardBg ?? derivedExportColors.cardBg;
	const infoBg = themeExport.infoBg ?? derivedExportColors.infoBg;
	const highlightedCode = await buildHighlightedCodeMap(sessionData, themeName);
	const sessionDataWithHighlights: SessionData = highlightedCode ? { ...sessionData, highlightedCode } : sessionData;

	// Base64 encode session data to avoid escaping issues
	const sessionDataBase64 = Buffer.from(JSON.stringify(sessionDataWithHighlights)).toString("base64");

	// Build the CSS with theme variables injected
	const css = templateCss
		.replace("{{THEME_VARS}}", themeVars)
		.replace("{{BODY_BG}}", bodyBg)
		.replace("{{CONTAINER_BG}}", containerBg)
		.replace("{{INFO_BG}}", infoBg);

	return template
		.replace("{{CSS}}", css)
		.replace("{{JS}}", templateJs)
		.replace("{{SESSION_DATA}}", sessionDataBase64)
		.replace("{{MARKED_JS}}", markedJs);
}

/** Tools rendered directly by the HTML template (not pre-rendered via TUI→ANSI→HTML pipeline) */
const TEMPLATE_RENDERED_TOOLS = new Set(["bash", "read", "write", "edit", "ls"]);

/**
 * Pre-render custom tools to HTML using their TUI renderers.
 */
function preRenderCustomTools(
	entries: SessionEntry[],
	toolRenderer: ToolHtmlRenderer,
): Record<string, RenderedToolHtml> {
	const renderedTools: Record<string, RenderedToolHtml> = {};

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;

		// Find tool calls in assistant messages
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "toolCall" && !TEMPLATE_RENDERED_TOOLS.has(block.name)) {
					const callHtml = toolRenderer.renderCall(block.id, block.name, block.arguments);
					if (callHtml) {
						renderedTools[block.id] = { callHtml };
					}
				}
			}
		}

		// Find tool results
		if (msg.role === "toolResult" && msg.toolCallId) {
			const toolName = msg.toolName || "";
			// Only render if we have a pre-rendered call OR it's not template-rendered
			const existing = renderedTools[msg.toolCallId];
			if (existing || !TEMPLATE_RENDERED_TOOLS.has(toolName)) {
				const rendered = toolRenderer.renderResult(
					msg.toolCallId,
					toolName,
					msg.content,
					msg.details,
					msg.isError || false,
				);
				if (rendered) {
					renderedTools[msg.toolCallId] = {
						...existing,
						resultHtmlCollapsed: rendered.collapsed,
						resultHtmlExpanded: rendered.expanded,
					};
				}
			}
		}
	}

	return renderedTools;
}

/**
 * Export session to HTML using SessionManager and AgentState.
 * Used by TUI's /export command.
 */
export async function exportSessionToHtml(
	sm: SessionManager,
	state?: AgentState,
	options?: ExportOptions | string,
): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};

	const sessionFile = sm.getSessionFile();
	if (!sessionFile) {
		throw new Error("Cannot export in-memory session to HTML");
	}
	if (!existsSync(sessionFile)) {
		throw new Error("Nothing to export yet - start a conversation first");
	}

	const entries = sm.getEntries();

	// Pre-render custom tools if a tool renderer is provided
	let renderedTools: Record<string, RenderedToolHtml> | undefined;
	if (opts.toolRenderer) {
		renderedTools = preRenderCustomTools(entries, opts.toolRenderer);
		// Only include if we actually rendered something
		if (Object.keys(renderedTools).length === 0) {
			renderedTools = undefined;
		}
	}

	const sessionData: SessionData = {
		header: sm.getHeader(),
		entries,
		leafId: sm.getLeafId(),
		systemPrompt: state?.systemPrompt,
		tools: state?.tools?.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
		renderedTools,
	};

	const html = await generateHtml(sessionData, opts.themeName);

	let outputPath = opts.outputPath;
	if (!outputPath) {
		const sessionBasename = basename(sessionFile, ".jsonl");
		outputPath = `${APP_NAME}-session-${sessionBasename}.html`;
	}

	writeFileSync(outputPath, html, "utf8");
	return outputPath;
}

/**
 * Export session file to HTML (standalone, without AgentState).
 * Used by CLI for exporting arbitrary session files.
 */
export async function exportFromFile(inputPath: string, options?: ExportOptions | string): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};

	if (!existsSync(inputPath)) {
		throw new Error(`File not found: ${inputPath}`);
	}

	const sm = SessionManager.open(inputPath);

	const sessionData: SessionData = {
		header: sm.getHeader(),
		entries: sm.getEntries(),
		leafId: sm.getLeafId(),
		systemPrompt: undefined,
		tools: undefined,
	};

	const html = await generateHtml(sessionData, opts.themeName);

	let outputPath = opts.outputPath;
	if (!outputPath) {
		const inputBasename = basename(inputPath, ".jsonl");
		outputPath = `${APP_NAME}-session-${inputBasename}.html`;
	}

	writeFileSync(outputPath, html, "utf8");
	return outputPath;
}
