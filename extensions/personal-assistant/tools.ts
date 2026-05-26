/**
 * Personal Assistant Tools Extension
 *
 * Provides three tools for the Pi coding agent:
 * - todo_write: Manage a persistent todo list
 * - web_search: Search the web via Tavily or DuckDuckGo
 * - web_fetch: Fetch and extract text from web pages
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ============================================================================
// Config Loading
// ============================================================================

interface SearchConfig {
	provider: "tavily" | "duckduckgo";
	api_key?: string;
	max_results?: number;
	timeout?: number;
}

interface PersonalAssistantConfig {
	search?: SearchConfig;
}

interface PiSettings {
	personalAssistant?: PersonalAssistantConfig;
}

function getConfigPath(): string {
	return join(homedir(), ".pi", "agent", "settings.json");
}

function getTodoPath(): string {
	return join(homedir(), ".pi", "agent", "data", "todo.json");
}

function loadSettings(): PiSettings {
	const configPath = getConfigPath();
	try {
		if (existsSync(configPath)) {
			const raw = readFileSync(configPath, "utf-8");
			return JSON.parse(raw) as PiSettings;
		}
	} catch {
		// Config file missing or invalid — use defaults
	}
	return {};
}

function ensureDirectory(filePath: string): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

// ============================================================================
// Todo Types
// ============================================================================

interface Todo {
	id: string;
	content: string;
	priority: "low" | "medium" | "high";
	category: string;
	completed: boolean;
	created_at: string;
	updated_at: string;
}

function loadTodos(): Todo[] {
	const todoPath = getTodoPath();
	try {
		if (existsSync(todoPath)) {
			const raw = readFileSync(todoPath, "utf-8");
			return JSON.parse(raw) as Todo[];
		}
	} catch {
		// File missing or invalid
	}
	return [];
}

function saveTodos(todos: Todo[]): void {
	const todoPath = getTodoPath();
	ensureDirectory(todoPath);
	writeFileSync(todoPath, JSON.stringify(todos, null, 2), "utf-8");
}

function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ============================================================================
// SSRF Protection
// ============================================================================

function isPrivateIP(hostname: string): boolean {
	// IPv4 private ranges
	if (/^127\./.test(hostname)) return true;
	if (/^10\./.test(hostname)) return true;
	if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)) return true;
	if (/^192\.168\./.test(hostname)) return true;
	if (/^0\./.test(hostname)) return true;
	if (hostname === "localhost") return true;
	// IPv6 loopback
	if (hostname === "::1" || hostname === "[::1]") return true;
	if (hostname === "0:0:0:0:0:0:0:1") return true;
	return false;
}

// ============================================================================
// HTML to Text Conversion
// ============================================================================

function htmlToText(html: string): string {
	let text = html;
	// Remove script and style tags with content
	text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
	text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
	// Remove HTML comments
	text = text.replace(/<!--[\s\S]*?-->/g, "");
	// Replace common block elements with newlines
	text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|header|footer|nav)>/gi, "\n");
	text = text.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(/<hr\s*\/?>/gi, "\n---\n");
	// Replace list items
	text = text.replace(/<li\b[^>]*>/gi, "- ");
	// Remove all remaining tags
	text = text.replace(/<[^>]+>/g, " ");
	// Decode common HTML entities
	text = text.replace(/&amp;/g, "&");
	text = text.replace(/&lt;/g, "<");
	text = text.replace(/&gt;/g, ">");
	text = text.replace(/&quot;/g, '"');
	text = text.replace(/&#39;/g, "'");
	text = text.replace(/&nbsp;/g, " ");
	text = text.replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)));
	text = text.replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
	// Normalize whitespace
	text = text.replace(/[ \t]+/g, " ");
	text = text.replace(/\n\s*\n\s*\n+/g, "\n\n");
	text = text.trim();
	return text;
}

// ============================================================================
// Tool Definitions
// ============================================================================

const TodoWriteParams = Type.Object({
	todos: Type.Array(
		Type.Object({
			action: Type.Union([Type.Literal("add"), Type.Literal("done"), Type.Literal("update"), Type.Literal("list")]),
			id: Type.Optional(Type.String()),
			content: Type.Optional(Type.String()),
			priority: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
			category: Type.Optional(Type.String()),
		}),
	),
	merge: Type.Optional(Type.Boolean()),
});

const WebSearchParams = Type.Object({
	query: Type.String(),
	max_results: Type.Optional(Type.Number()),
});

const WebFetchParams = Type.Object({
	url: Type.String(),
	max_length: Type.Optional(Type.Number()),
});

// ============================================================================
// Tool Registration
// ============================================================================

export function registerTools(pi: ExtensionAPI): void {
	// ----------------------------------------------------------------
	// todo_write
	// ----------------------------------------------------------------
	pi.registerTool({
		name: "todo_write",
		label: "Todo Write",
		description:
			"Manage a persistent todo list stored at ~/.pi/agent/data/todo.json. " +
			"Supports batch operations: add (create new todos), done (mark complete by id), " +
			"update (modify content/priority by id), list (return summary). " +
			"When merge is true (default), add operations append to existing items. " +
			"When false, existing items are replaced by the new set.",
		promptSnippet: "Manage a persistent todo list with add, done, update, and list actions.",
		parameters: TodoWriteParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const merge = params.merge !== false; // default true
			let todos = loadTodos();
			const results: string[] = [];

			for (const item of params.todos) {
				switch (item.action) {
					case "add": {
						if (!item.content) {
							results.push("Error: content is required for add action");
							continue;
						}
						const newTodo: Todo = {
							id: generateId(),
							content: item.content,
							priority: item.priority ?? "medium",
							category: item.category ?? "general",
							completed: false,
							created_at: new Date().toISOString(),
							updated_at: new Date().toISOString(),
						};
						if (merge) {
							todos.push(newTodo);
						} else {
							todos = [newTodo];
						}
						results.push(`Added todo ${newTodo.id}: ${newTodo.content}`);
						break;
					}

					case "done": {
						if (!item.id) {
							results.push("Error: id is required for done action");
							continue;
						}
						const todo = todos.find((t) => t.id === item.id);
						if (!todo) {
							results.push(`Error: todo ${item.id} not found`);
							continue;
						}
						todo.completed = true;
						todo.updated_at = new Date().toISOString();
						results.push(`Marked todo ${todo.id} as done: ${todo.content}`);
						break;
					}

					case "update": {
						if (!item.id) {
							results.push("Error: id is required for update action");
							continue;
						}
						const todo = todos.find((t) => t.id === item.id);
						if (!todo) {
							results.push(`Error: todo ${item.id} not found`);
							continue;
						}
						if (item.content) todo.content = item.content;
						if (item.priority) todo.priority = item.priority;
						if (item.category) todo.category = item.category;
						todo.updated_at = new Date().toISOString();
						results.push(`Updated todo ${todo.id}`);
						break;
					}

					case "list": {
						const total = todos.length;
						const completed = todos.filter((t) => t.completed).length;
						const uncompleted = total - completed;

						const grouped: Record<string, Todo[]> = { high: [], medium: [], low: [] };
						for (const t of todos) {
							if (!t.completed) {
								grouped[t.priority].push(t);
							}
						}

						let summary = `Total: ${total} (${completed} completed, ${uncompleted} pending)\n`;
						summary += `\nPending by priority:`;
						summary += `\n  High: ${grouped.high.map((t) => `${t.id} - ${t.content}`).join(", ") || "(none)"}`;
						summary += `\n  Medium: ${grouped.medium.map((t) => `${t.id} - ${t.content}`).join(", ") || "(none)"}`;
						summary += `\n  Low: ${grouped.low.map((t) => `${t.id} - ${t.content}`).join(", ") || "(none)"}`;

						if (completed > 0) {
							summary += `\n\nCompleted:`;
							for (const t of todos.filter((t) => t.completed)) {
								summary += `\n  ${t.id} - ${t.content}`;
							}
						}

						results.push(summary);
						break;
					}
				}
			}

			// Save after processing all items (except pure list operations)
			const hasMutations = params.todos.some((t) => t.action !== "list");
			if (hasMutations) {
				saveTodos(todos);
			}

			return {
				content: [{ type: "text", text: results.join("\n\n") }],
				details: { todos, actionCount: params.todos.length },
			};
		},
	});

	// ----------------------------------------------------------------
	// web_search
	// ----------------------------------------------------------------
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web using the configured search provider (Tavily or DuckDuckGo). " +
			"Returns search results with titles, URLs, and snippets.",
		promptSnippet: "Search the web for information.",
		parameters: WebSearchParams,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const config = loadSettings();
			const searchConfig = config.personalAssistant?.search;
			const provider = searchConfig?.provider ?? "duckduckgo";
			const apiKey = searchConfig?.api_key;
			const maxResults = params.max_results ?? searchConfig?.max_results ?? 5;
			const timeout = searchConfig?.timeout ?? 15000;

			try {
				if (provider === "tavily") {
					if (!apiKey) {
						return {
							content: [{ type: "text", text: "Error: Tavily API key not configured in ~/.pi/agent/settings.json" }],
							details: { error: "missing_api_key" },
						};
					}

					const response = await fetch("https://api.tavily.com/search", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							api_key: apiKey,
							query: params.query,
							max_results: maxResults,
						}),
						signal,
					});

					if (!response.ok) {
						return {
							content: [{ type: "text", text: `Error: Tavily API returned ${response.status}` }],
							details: { error: "api_error", status: response.status },
						};
					}

					const data = (await response.json()) as {
						results?: Array<{ title: string; url: string; content: string }>;
					};

					const results = (data.results ?? []).map((r) => ({
						title: r.title,
						url: r.url,
						snippet: r.content,
					}));

					const text = results
						.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
						.join("\n\n");

					return {
						content: [{ type: "text", text: text || "No results found" }],
						details: { provider: "tavily", results },
					};
				} else {
					// DuckDuckGo
					const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(params.query)}&format=json&no_html=1&skip_disambig=1`;

					const controller = new AbortController();
					const timeoutId = setTimeout(() => controller.abort(), timeout);
					const combinedSignal = signal
						? AbortSignal.any([signal, controller.signal])
						: controller.signal;

					try {
						const response = await fetch(url, {
							headers: { "User-Agent": "pi-personal-assistant/1.0" },
							signal: combinedSignal,
						});

						if (!response.ok) {
							return {
								content: [{ type: "text", text: `Error: DuckDuckGo API returned ${response.status}` }],
								details: { error: "api_error", status: response.status },
							};
						}

						const data = (await response.json()) as {
							AbstractText?: string;
							AbstractURL?: string;
							Heading?: string;
							RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
						};

						const results: Array<{ title: string; url: string; snippet: string }> = [];

						// Add the main abstract if present
						if (data.AbstractText && data.AbstractURL) {
							results.push({
								title: data.Heading ?? params.query,
								url: data.AbstractURL,
								snippet: data.AbstractText,
							});
						}

						// Add related topics
						for (const topic of data.RelatedTopics ?? []) {
							if (results.length >= maxResults) break;
							if (topic.Text && topic.FirstURL) {
								results.push({
									title: topic.Text.split(" - ")[0]?.trim() ?? topic.Text.slice(0, 60),
									url: topic.FirstURL,
									snippet: topic.Text,
								});
							}
						}

						const text = results
							.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
							.join("\n\n");

						return {
							content: [{ type: "text", text: text || "No results found" }],
							details: { provider: "duckduckgo", results },
						};
					} finally {
						clearTimeout(timeoutId);
					}
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Search error: ${message}` }],
					details: { error: "fetch_error", message },
				};
			}
		},
	});

	// ----------------------------------------------------------------
	// web_fetch
	// ----------------------------------------------------------------
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a web page and convert it to plain text. " +
			"Supports http/https URLs only. Blocks requests to private IP ranges (SSRF protection). " +
			"Content is truncated to max_length (default 8000) characters.",
		promptSnippet: "Fetch and read web page content as text.",
		parameters: WebFetchParams,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			// Validate URL
			let parsed: URL;
			try {
				parsed = new URL(params.url);
			} catch {
				return {
					content: [{ type: "text", text: "Error: Invalid URL format" }],
					details: { error: "invalid_url" },
				};
			}

			// Only allow http/https
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				return {
					content: [{ type: "text", text: "Error: Only http and https URLs are allowed" }],
					details: { error: "invalid_protocol", protocol: parsed.protocol },
				};
			}

			// SSRF protection — check hostname
			if (isPrivateIP(parsed.hostname)) {
				return {
					content: [{ type: "text", text: "Error: Requests to private IP addresses are not allowed" }],
					details: { error: "ssrf_blocked", hostname: parsed.hostname },
				};
			}

			const maxLength = params.max_length ?? 8000;

			try {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 30000);
				const combinedSignal = signal
					? AbortSignal.any([signal, controller.signal])
					: controller.signal;

				let response: Response;
				try {
					response = await fetch(params.url, {
						headers: {
							"User-Agent": "pi-personal-assistant/1.0",
							Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
						},
						signal: combinedSignal,
						redirect: "follow",
					});
				} finally {
					clearTimeout(timeoutId);
				}

				if (!response.ok) {
					return {
						content: [{ type: "text", text: `Error: HTTP ${response.status} ${response.statusText}` }],
						details: { error: "http_error", status: response.status },
					};
				}

				const contentType = response.headers.get("content-type") ?? "";
				const html = await response.text();

				let text: string;

				if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
					text = htmlToText(html);
				} else {
					// Plain text or other — use as-is
					text = html;
				}

				// Truncate
				if (text.length > maxLength) {
					text = text.slice(0, maxLength) + "\n\n[Content truncated]";
				}

				return {
					content: [{ type: "text", text }],
					details: {
						url: params.url,
						contentType,
						originalLength: html.length,
						returnedLength: text.length,
					},
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Fetch error: ${message}` }],
					details: { error: "fetch_error", message },
				};
			}
		},
	});
}
