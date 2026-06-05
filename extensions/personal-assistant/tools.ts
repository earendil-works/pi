import type { ExtensionAPI, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
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

// ============================================================================
// MCP Config Loading (mirrors settings-manager.ts loadMcpConfig)
// ============================================================================

const MCP_CONFIG_FILE = "mcp.json";

interface McpServerConfig {
	url: string;
	token: string;
	enabled?: boolean;
	remotePathPattern?: string;
}

function getAgentDir(): string {
	return join(homedir(), ".pi", "agent");
}

function loadMcpConfig(): Record<string, McpServerConfig> {
	const configPath = join(getAgentDir(), MCP_CONFIG_FILE);
	if (!existsSync(configPath)) return {};
	try {
		return JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, McpServerConfig>;
	} catch {
		return {};
	}
}

/**
 * Build the remote paths prompt injection text from satellite MCP server configs.
 * Only servers named "satellite" with a non-empty remotePathPattern are included.
 */
export function buildRemotePathsPrompt(
	configs: Array<{ name: string; remotePathPattern?: string }>,
): string {
	const sections: string[] = [];
	for (const config of configs) {
		if (config.name === "satellite" && config.remotePathPattern) {
			sections.push(
				`## Remote Paths\n\nFiles matching pattern \`${config.remotePathPattern}\` are on the remote HPC server. Use \`satellite_remote_exec\` for all file operations on these paths (read_file, write_file, edit_file, list_dir, find_files, grep_files, transfer_file). Do NOT use local bash/read/write/edit on these paths.`,
			);
		}
	}
	return sections.join("\n\n");
}

// ============================================================================
// SSRF Protection
// ============================================================================

function isPrivateIP(hostname: string): boolean {
	if (/^127\./.test(hostname)) return true;
	if (/^10\./.test(hostname)) return true;
	if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)) return true;
	if (/^192\.168\./.test(hostname)) return true;
	if (/^0\./.test(hostname)) return true;
	if (hostname === "localhost") return true;
	if (hostname === "::1" || hostname === "[::1]") return true;
	if (hostname === "0:0:0:0:0:0:0:1") return true;
	return false;
}

// ============================================================================
// HTML to Text Conversion
// ============================================================================

function htmlToText(html: string): string {
	let text = html;
	text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
	text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
	text = text.replace(/<!--[\s\S]*?-->/g, "");
	text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|header|footer|nav)>/gi, "\n");
	text = text.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(/<hr\s*\/?>/gi, "\n---\n");
	text = text.replace(/<li\b[^>]*>/gi, "- ");
	text = text.replace(/<[^>]+>/g, " ");
	text = text.replace(/&amp;/g, "&");
	text = text.replace(/&lt;/g, "<");
	text = text.replace(/&gt;/g, ">");
	text = text.replace(/&quot;/g, '"');
	text = text.replace(/&#39;/g, "'");
	text = text.replace(/&nbsp;/g, " ");
	text = text.replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)));
	text = text.replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
	text = text.replace(/[ \t]+/g, " ");
	text = text.replace(/\n\s*\n\s*\n+/g, "\n\n");
	text = text.trim();
	return text;
}

// ============================================================================
// Todowrite — Claude-style ephemeral planning tool
// ============================================================================

interface TodoItem {
	id: string;
	content: string;
	status: "pending" | "in_progress" | "completed" | "cancelled";
}

type TodoStatus = TodoItem["status"];

const VALID_STATUSES: TodoStatus[] = ["pending", "in_progress", "completed", "cancelled"];

const VALID_TRANSITIONS: Record<TodoStatus, TodoStatus[]> = {
	pending: ["in_progress", "cancelled"],
	in_progress: ["completed", "cancelled", "pending"],
	completed: ["pending"],
	cancelled: ["pending"],
};

const MAX_IN_PROGRESS = 3;
const MAX_ITEMS = 20;
const PLAN_REMINDER_INTERVAL = 8;

let todoItems: TodoItem[] = [];
let roundsSinceTodo = 0;
let contextCount = 0;

function renderTodos(): string {
	if (todoItems.length === 0) return "No todos.";
	const lines = todoItems.map((t) => {
		const marker = t.status === "pending" ? "[ ]"
			: t.status === "in_progress" ? "[>]"
			: t.status === "completed" ? "[x]"
			: "[-]";
		return `${marker} #${t.id}: ${t.content}`;
	});
	const done = todoItems.filter((t) => t.status === "completed").length;
	lines.push(`\n(${done}/${todoItems.length} completed)`);
	return lines.join("\n");
}

function validateItems(items: { id: string; content: string; status: string }[]): string | null {
	if (items.length > 20) {
		return "Error: Maximum 20 todos allowed.";
	}

	const inProgressCount = items.filter((t) => t.status === "in_progress").length;
	if (inProgressCount > 1) {
		return "Error: Only one task can be in_progress at a time.";
	}

	for (const item of items) {
		if (!item.content || item.content.trim().length === 0) {
			return `Error: Item ${item.id}: content is required.`;
		}
		if (!VALID_STATUSES.includes(item.status as TodoStatus)) {
			return `Error: Item ${item.id}: Invalid status "${item.status}". Must be one of: ${VALID_STATUSES.join(", ")}.`;
		}

		const prev = todoItems.find((t) => t.id === item.id);
		if (prev && !VALID_TRANSITIONS[prev.status].includes(item.status as TodoStatus)) {
			return `Error: Item #${item.id}: Cannot transition from "${prev.status}" to "${item.status}". Allowed transitions: ${VALID_TRANSITIONS[prev.status].join(" → ")}.`;
		}
	}

	return null;
}

// ============================================================================
// Tool Parameter Schemas
// ============================================================================

const TodowriteParams = Type.Object({
	items: Type.Array(
		Type.Object({
			id: Type.String({ description: "Unique identifier for this todo item" }),
			content: Type.String({ description: "Description of the task to complete" }),
			status: Type.Union(
				[
					Type.Literal("pending"),
					Type.Literal("in_progress"),
					Type.Literal("completed"),
					Type.Literal("cancelled"),
				],
				{
					description:
						"pending: not started, in_progress: actively working, completed: done, cancelled: abandoned",
				},
			),
		}),
		{ minItems: 1 },
	),
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
	// ============================================================================
	// Hook: before_agent_start — reset state + inject todowrite rules
	// ============================================================================

	pi.on("before_agent_start", (event) => {
		todoItems = [];
		roundsSinceTodo = 0;
		contextCount = 0;

		// Layer A: Inject remote paths prompt if satellite MCP server has remotePathPattern
		const mcpConfig = loadMcpConfig();
		const satelliteConfigs = Object.entries(mcpConfig).map(([name, config]) => ({
			name,
			remotePathPattern: config.remotePathPattern,
		}));
		const remotePathsPrompt = buildRemotePathsPrompt(satelliteConfigs);

		const planningSection = [
			"",
			"",
			"## Planning",
			"",
			"You have a Todowrite tool available for planning and tracking multi-step tasks (3+ steps).",
			"Rules:",
			"  1. Create a plan with todowrite before starting a multi-step task",
			"  2. Mark the current step as in_progress before working on it",
			"  3. Mark steps as completed when done — update after EVERY step, do not batch completions",
			"  4. Up to 3 items can be in_progress at a time (for parallel workflows)",
			"  5. Use activeForm to describe what you're currently doing (e.g., 'Writing tests')",
			"  6. Simple single-step tasks do not need a plan — use Todowrite only when it helps",
			"",
			"Your todo list is currently empty. Do not tell the user about this. If the current task benefits from planning, create one. Otherwise, ignore.",
		].join("\n");

		return {
			systemPrompt:
			systemPrompt:
				event.systemPrompt + planningSection + (remotePathsPrompt ? "

" + remotePathsPrompt : ""),
			};
		});		};
	});

	// ============================================================================
	// Hook: context — inject nag reminders
	// ============================================================================

	pi.on("context", (event: { messages: AgentMessage[] }) => {
		contextCount++;

		const hasActiveItems = todoItems.some(
			(t) => t.status === "pending" || t.status === "in_progress",
		);
		if (hasActiveItems && roundsSinceTodo >= 3) {
			event.messages.push({
				role: "user",
				content: [
					{
						type: "text",
						text: '<hmr note>todos stale, consider updating.</hmr note>',
					},
				],
				timestamp: Date.now(),
			});
			roundsSinceTodo = 0;
		}
	});

	// ============================================================================
	// Hook: turn_end — detect todowrite usage, update counter
	// ============================================================================

	pi.on("turn_end", (event: TurnEndEvent) => {
		const messageContent = "content" in event.message ? event.message.content : undefined;
		const blocks = Array.isArray(messageContent) ? messageContent : [];
		const usedTodo = blocks.some(
			(block: { type: string; name?: string }) => block.type === "tool_use" && block.name === "todowrite",
		);

		if (usedTodo) {
			roundsSinceTodo = 0;
		} else {
			const hasActiveItems = todoItems.some(
				(t) => t.status === "pending" || t.status === "in_progress",
			);
			if (hasActiveItems) {
				roundsSinceTodo++;
			}
		}
	});

	// ============================================================================
	// todowrite
	// ============================================================================

	pi.registerTool({
		name: "todowrite",
		label: "Todowrite",
		description:
			"Plan and track progress for multi-step tasks. Each item has id, content, and status (pending/in_progress/completed/cancelled). " +
			"Send the COMPLETE list of all items on every call (full replacement). " +
			"Only one item can be in_progress at a time. Max 20 items.",
		promptSnippet: "Plan and track progress for multi-step tasks.",
		parameters: TodowriteParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const items = params.items;

			const error = validateItems(items);
			if (error) {
				return {
					content: [{ type: "text", text: error }],
					details: { error, currentTodos: renderTodos() },
				};
			}

			todoItems = items.map((item) => ({
				id: item.id,
				content: item.content.trim(),
				status: item.status as TodoStatus,
			}));

			return {
				content: [{ type: "text", text: renderTodos() }],
				details: { items: todoItems },
			};
		},
	});

	// ============================================================================
	// web_search
	// ============================================================================

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

						if (data.AbstractText && data.AbstractURL) {
							results.push({
								title: data.Heading ?? params.query,
								url: data.AbstractURL,
								snippet: data.AbstractText,
							});
						}

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

	// ============================================================================
	// web_fetch
	// ============================================================================

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
			let parsed: URL;
			try {
				parsed = new URL(params.url);
			} catch {
				return {
					content: [{ type: "text", text: "Error: Invalid URL format" }],
					details: { error: "invalid_url" },
				};
			}

			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				return {
					content: [{ type: "text", text: "Error: Only http and https URLs are allowed" }],
					details: { error: "invalid_protocol", protocol: parsed.protocol },
				};
			}

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
					text = html;
				}

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
