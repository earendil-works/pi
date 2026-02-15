import { Agent, type Attachment, ProviderTransport, type ThinkingLevel } from "@kennyfrc/mu-agent-core";
import type { AgentTool, Api, KnownProvider, Model } from "@kennyfrc/mu-ai";
import { supportsXhigh } from "@kennyfrc/mu-ai";
import { ProcessTerminal, TUI } from "@kennyfrc/mu-tui";
import type { TSchema } from "@sinclair/typebox";
import chalk from "chalk";
import { existsSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, extname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { exportFromFile } from "./export-html.js";
import { ExtensionLoader } from "./extensions/loader.js";
import { ExtensionManager } from "./extensions/manager.js";
import { ensureIdentityEnv } from "./identity-env.js";
import { findModel, getApiKeyForModel, getAvailableModels } from "./model-config.js";
import { buildSystemPrompt as buildSystemPromptFromYaml } from "./prompts/index.js";
import { setCurrentModel } from "./runtime-state.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { initThemeWithGhostty } from "./theme/theme.js";
import { allTools, type ToolName } from "./tools/index.js";
import { resolveToolSelection, type ToolSelection } from "./tools/tool-selection.js";
import { ensureTool } from "./tools-manager.js";
import { SessionSelectorComponent } from "./tui/session-selector.js";
import { TuiRenderer } from "./tui/tui-renderer.js";

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));
const VERSION = packageJson.version;

const defaultModelPerProvider: Record<KnownProvider, string> = {
	anthropic: "claude-sonnet-4-5",
	openai: "gpt-5.1-codex",
	"openai-codex": "gpt-5.3-codex",
	"github-copilot": "gpt-4o",
	google: "gemini-2.5-pro",
	"google-gemini-cli": "gemini-2.5-pro",
	"google-antigravity": "gemini-3-pro-high",
	moonshot: "kimi-k2.5",
	openrouter: "openai/gpt-5.1-codex",
	xai: "grok-4-fast-non-reasoning",
	groq: "openai/gpt-oss-120b",
	cerebras: "zai-glm-4.6",
	zai: "glm-4.6",
	mistral: "devstral-medium-2507",
	synthetic: "hf:deepseek-ai/DeepSeek-V3-0324",
};

type Mode = "text" | "json" | "rpc";

interface Args {
	provider?: string;
	model?: string;
	apiKey?: string;
	systemPrompt?: string;
	thinking?: ThinkingLevel;
	continue?: boolean;
	resume?: boolean;
	resumeUuid?: string;
	help?: boolean;
	version?: boolean;
	mode?: Mode;
	noSession?: boolean;
	session?: string;
	models?: string[];
	tools?: ToolName[];
	print?: boolean;
	export?: string;
	messages: string[];
	fileArgs: string[];
}

function parseArgs(args: string[]): Args {
	const result: Args = {
		messages: [],
		fileArgs: [],
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v") {
			result.version = true;
		} else if (arg === "--mode" && i + 1 < args.length) {
			const mode = args[++i];
			if (mode === "text" || mode === "json" || mode === "rpc") {
				result.mode = mode;
			}
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--resume" || arg === "-r") {
			result.resume = true;
			// Check if next arg is a UUID (not a flag)
			if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
				result.resumeUuid = args[++i];
			}
		} else if (arg === "--provider" && i + 1 < args.length) {
			result.provider = args[++i];
		} else if (arg === "--model" && i + 1 < args.length) {
			result.model = args[++i];
		} else if (arg === "--api-key" && i + 1 < args.length) {
			result.apiKey = args[++i];
		} else if (arg === "--system-prompt" && i + 1 < args.length) {
			result.systemPrompt = args[++i];
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--session" && i + 1 < args.length) {
			result.session = args[++i];
		} else if (arg === "--models" && i + 1 < args.length) {
			result.models = args[++i].split(",").map((s) => s.trim());
		} else if (arg === "--tools" && i + 1 < args.length) {
			const toolNames = args[++i].split(",").map((s) => s.trim());
			const validTools: ToolName[] = [];

			// Backward compatibility: map legacy/pretty names to snake_case tool names
			const legacyToNew: Record<string, ToolName> = {
				// Preferred / canonical
				read: "read",
				write: "write",
				edit: "edit",
				apply_patch: "apply_patch",
				bash: "bash",
				grep: "grep",
				glob: "glob",
				list_threads: "list_threads",
				read_thread: "read_thread",
				read_image: "read_image",
				todo: "todo",
				todo_write: "todo_write",
				handoff: "handoff",
				exec_command: "exec_command",
				view_image: "view_image",
				update_plan: "update_plan",

				// Legacy / aliases
				Read: "read",
				Write: "write",
				Edit: "edit",
				ApplyPatch: "apply_patch",
				Bash: "bash",
				Grep: "grep",
				Glob: "glob",
				ListThreads: "list_threads",
				ReadThread: "read_thread",
				ReadImage: "read_image",
				Todo: "todo",
				Handoff: "handoff",
				applypatch: "apply_patch",
				find: "glob",
				ls: "glob",
				todowrite: "todo",
			};

			for (const name of toolNames) {
				// Try direct match first, then legacy mapping
				const resolved =
					name in allTools ? (name as ToolName) : (legacyToNew[name] ?? legacyToNew[name.toLowerCase()]);
				if (resolved && resolved in allTools) {
					if (!validTools.includes(resolved)) {
						validTools.push(resolved);
					}
				} else {
					console.error(
						chalk.yellow(`Warning: Unknown tool "${name}". Valid tools: ${Object.keys(allTools).join(", ")}`),
					);
				}
			}
			result.tools = validTools;
		} else if (arg === "--thinking" && i + 1 < args.length) {
			const level = args[++i];
			if (level === "off" || level === "minimal" || level === "low" || level === "medium" || level === "high") {
				result.thinking = level;
			} else {
				console.error(
					chalk.yellow(
						`Warning: Invalid thinking level "${level}". Valid values: off, minimal, low, medium, high`,
					),
				);
			}
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
		} else if (arg === "--export" && i + 1 < args.length) {
			result.export = args[++i];
		} else if (arg.startsWith("@")) {
			result.fileArgs.push(arg.slice(1)); // Remove @ prefix
		} else if (!arg.startsWith("-")) {
			result.messages.push(arg);
		}
	}

	return result;
}

/**
 * Map of file extensions to MIME types for common image formats
 */
const IMAGE_MIME_TYPES: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
};

/**
 * Check if a file is an image based on its extension
 */
function isImageFile(filePath: string): string | null {
	const ext = extname(filePath).toLowerCase();
	return IMAGE_MIME_TYPES[ext] || null;
}

/**
 * Expand ~ to home directory
 */
function expandPath(filePath: string): string {
	if (filePath === "~") {
		return homedir();
	}
	if (filePath.startsWith("~/")) {
		return homedir() + filePath.slice(1);
	}
	return filePath;
}

/**
 * Process @file arguments into text content and image attachments
 */
function processFileArguments(fileArgs: string[]): { textContent: string; imageAttachments: Attachment[] } {
	let textContent = "";
	const imageAttachments: Attachment[] = [];

	for (const fileArg of fileArgs) {
		// Expand and resolve path
		const expandedPath = expandPath(fileArg);
		const absolutePath = resolve(expandedPath);

		// Check if file exists
		if (!existsSync(absolutePath)) {
			console.error(chalk.red(`Error: File not found: ${absolutePath}`));
			process.exit(1);
		}

		// Check if file is empty
		const stats = statSync(absolutePath);
		if (stats.size === 0) {
			// Skip empty files
			continue;
		}

		const mimeType = isImageFile(absolutePath);

		if (mimeType) {
			// Handle image file
			const content = readFileSync(absolutePath);
			const base64Content = content.toString("base64");

			const attachment: Attachment = {
				id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
				type: "image",
				fileName: absolutePath.split("/").pop() || absolutePath,
				mimeType,
				size: stats.size,
				content: base64Content,
			};

			imageAttachments.push(attachment);

			// Add text reference to image
			textContent += `<file name="${absolutePath}"></file>\n`;
		} else {
			// Handle text file
			try {
				const content = readFileSync(absolutePath, "utf-8");
				textContent += `<file name="${absolutePath}">\n${content}\n</file>\n`;
			} catch (error: any) {
				console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${error.message}`));
				process.exit(1);
			}
		}
	}

	return { textContent, imageAttachments };
}

function printHelp() {
	console.log(`${chalk.bold("mu")} - AI assistant with read, bash, edit/apply_patch, write tools

${chalk.bold("Usage:")}
  mu [options] [@files...] [messages...]

${chalk.bold("Options:")}
  --provider <name>       Provider name (default: google)
  --model <id>            Model ID (default: gemini-2.5-flash)
  --api-key <key>         API key (defaults to env vars)
  --system-prompt <text>  System prompt (default: built-in assistant prompt)
  --mode <mode>           Output mode: text (default), json, or rpc
  --print, -p             Non-interactive mode: process prompt and exit
  --continue, -c          Continue previous session
  --resume, -r [uuid]     Resume session (by UUID or pick from list)
  --session <path>        Use specific session file
  --no-session            Don't save session (ephemeral)
  --models <patterns>     Comma-separated model patterns for quick cycling with Ctrl+P
  --tools <tools>         Comma-separated list of tools to enable (default: read,bash,edit,write,list_threads,read_thread,read_image,todo,handoff; gpt*: read,exec_command,read_image,handoff,list_threads,read_thread)
                          Available: read, bash, edit, apply_patch, write, grep, glob, list_threads, read_thread, read_image, todo, todo_write, handoff, exec_command, view_image, update_plan
  --thinking <level>      Set thinking level: off, minimal, low, medium, high
  --export <file>         Export session file to HTML and exit
  --help, -h              Show this help

${chalk.bold("Examples:")}
  # Interactive mode
  mu

  # Interactive mode with initial prompt
  mu "List all .ts files in src/"

  # Include files in initial message
  mu @prompt.md @image.png "What color is the sky?"

  # Non-interactive mode (process and exit)
  mu -p "List all .ts files in src/"

  # Multiple messages (interactive)
  mu "Read package.json" "What dependencies do we have?"

  # Continue previous session
  mu --continue "What did we discuss?"

  # Resume a specific session by ID (shown on exit)
  mu --resume abc12345-1234-5678-9abc-def012345678

  # Use different model
  mu --provider openai --model gpt-4o-mini "Help me refactor this code"

  # Limit model cycling to specific models
  mu --models claude-sonnet,claude-haiku,gpt-4o

  # Cycle models with fixed thinking levels
  mu --models sonnet:high,haiku:low

  # Start with a specific thinking level
  mu --thinking high "Solve this complex problem"

  # Read-only mode (no file modifications possible)
  mu --tools read,grep,glob -p "Review the code in src/"

  # Export a session file to HTML
  mu --export ~/.mu/agent/sessions/--path--/session.jsonl
  mu --export session.jsonl output.html

${chalk.bold("Environment Variables:")}
  ANTHROPIC_API_KEY       - Anthropic Claude API key
  ANTHROPIC_OAUTH_TOKEN   - Anthropic OAuth token (alternative to API key)
  OPENAI_API_KEY          - OpenAI GPT API key
  GEMINI_API_KEY          - Google Gemini API key
  GROQ_API_KEY            - Groq API key
  CEREBRAS_API_KEY        - Cerebras API key
  XAI_API_KEY             - xAI Grok API key
  OPENROUTER_API_KEY      - OpenRouter API key
  ZAI_API_KEY             - ZAI API key
  MU_CODING_AGENT_DIR     - Session storage directory (default: ~/.mu/agent)

${chalk.bold(
	"Available Tools (default: read, bash, edit, write, list_threads, read_thread, read_image, todo, handoff; gpt*: read, exec_command, read_image, handoff, list_threads, read_thread):",
)}
  read         - Read file contents
  bash         - Execute bash commands
  edit         - Edit files with find/replace
  apply_patch  - Apply patch edits
  write        - Write files (creates/overwrites)
  list_threads - List past conversation threads
  read_thread  - Read a specific thread's conversation history
  read_image   - Analyze images and extract information
  todo         - File-backed todos (lists, claim/release, claim_next)
  todo_write   - Persist todo list to disk and emit a reminder to continue
  handoff      - Hand off to a new session with file context
  grep         - Search file contents (off by default)
  glob         - Find files by glob pattern or list directory contents (off by default)
  exec_command - Execute shell commands (Codex-style)
  view_image   - Load and view images (Codex-style)
  update_plan  - Update a durable plan (Codex-style)
`);
}

async function buildSystemPrompt(customPrompt?: string, tools?: Array<AgentTool<TSchema, unknown>>): Promise<string> {
	// Check if customPrompt is a file path that exists
	let resolvedCustomPrompt = customPrompt;
	if (customPrompt && existsSync(customPrompt)) {
		try {
			resolvedCustomPrompt = readFileSync(customPrompt, "utf-8");
		} catch (error) {
			console.error(chalk.yellow(`Warning: Could not read system prompt file ${customPrompt}: ${error}`));
			// Fall through to use as literal string
		}
	}

	const contextFiles = loadProjectContextFiles();

	return buildSystemPromptFromYaml({
		customPrompt: resolvedCustomPrompt,
		tools: tools?.map((t) => ({ name: t.name, description: t.description })),
		contextFiles,
	});
}

type ContextFile = { path: string; content: string; scope: "user" | "project" };

/**
 * Look for AGENTS.md or CLAUDE.md in a directory (prefers AGENTS.md)
 */
function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
	const candidates = ["AGENTS.md", "CLAUDE.md"];
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				return {
					path: filePath,
					content: readFileSync(filePath, "utf-8"),
				};
			} catch (error) {
				console.error(chalk.yellow(`Warning: Could not read ${filePath}: ${error}`));
			}
		}
	}
	return null;
}

/**
 * Load all project context files in order:
 * 1. Global: ~/.mu/agent/AGENTS.md or CLAUDE.md
 * 2. Parent directories (top-most first) down to cwd
 * Each returns {path, content} for separate messages
 */
function loadProjectContextFiles(): ContextFile[] {
	const contextFiles: ContextFile[] = [];

	// 1. Load global context from ~/.mu/agent/
	const homeDir = homedir();
	const globalContextDir = resolve(process.env.MU_CODING_AGENT_DIR || join(homeDir, ".mu/agent/"));
	const globalContext = loadContextFileFromDir(globalContextDir);
	if (globalContext) {
		contextFiles.push({ ...globalContext, scope: "user" });
	}

	// 2. Walk up from cwd to root, collecting all context files
	const cwd = process.cwd();
	const ancestorContextFiles: ContextFile[] = [];

	let currentDir = cwd;
	const root = resolve("/");

	while (true) {
		const contextFile = loadContextFileFromDir(currentDir);
		if (contextFile) {
			// Add to beginning so we get top-most parent first
			ancestorContextFiles.unshift({ ...contextFile, scope: "project" });
		}

		// Stop if we've reached root
		if (currentDir === root) break;

		// Move up one directory
		const parentDir = resolve(currentDir, "..");
		if (parentDir === currentDir) break; // Safety check
		currentDir = parentDir;
	}

	// Add ancestor files in order (top-most → cwd)
	contextFiles.push(...ancestorContextFiles);

	return contextFiles;
}

async function checkForNewVersion(currentVersion: string): Promise<string | null> {
	try {
		const response = await fetch("https://registry.npmjs.org/@kennyfrc/mu-coding-agent/latest");
		if (!response.ok) return null;

		const data = (await response.json()) as { version?: string };
		const latestVersion = data.version;

		if (latestVersion && latestVersion !== currentVersion) {
			return latestVersion;
		}

		return null;
	} catch (error) {
		// Silently fail - don't disrupt the user experience
		return null;
	}
}

/**
 * Resolve model patterns to actual Model objects with optional thinking levels
 * Format: "pattern:level" where :level is optional
 * For each pattern, finds all matching models and picks the best version:
 * 1. Prefer alias (e.g., claude-sonnet-4-5) over dated versions (claude-sonnet-4-5-20250929)
 * 2. If no alias, pick the latest dated version
 */
async function resolveModelScope(
	patterns: string[],
): Promise<Array<{ model: Model<Api>; thinkingLevel: ThinkingLevel }>> {
	const { models: availableModels, error } = await getAvailableModels();

	if (error) {
		console.warn(chalk.yellow(`Warning: Error loading models: ${error}`));
		return [];
	}

	const scopedModels: Array<{ model: Model<Api>; thinkingLevel: ThinkingLevel }> = [];

	for (const pattern of patterns) {
		// Parse pattern:level format
		const parts = pattern.split(":");
		const modelPattern = parts[0];
		let thinkingLevel: ThinkingLevel = "off";

		if (parts.length > 1) {
			const level = parts[1];
			if (level === "off" || level === "minimal" || level === "low" || level === "medium" || level === "high") {
				thinkingLevel = level;
			} else {
				console.warn(
					chalk.yellow(`Warning: Invalid thinking level "${level}" in pattern "${pattern}". Using "off" instead.`),
				);
			}
		}

		// Check for provider/modelId format (provider is everything before the first /)
		const slashIndex = modelPattern.indexOf("/");
		if (slashIndex !== -1) {
			const provider = modelPattern.substring(0, slashIndex);
			const modelId = modelPattern.substring(slashIndex + 1);
			const providerMatch = availableModels.find(
				(m) => m.provider.toLowerCase() === provider.toLowerCase() && m.id.toLowerCase() === modelId.toLowerCase(),
			);
			if (providerMatch) {
				if (
					!scopedModels.find(
						(sm) => sm.model.id === providerMatch.id && sm.model.provider === providerMatch.provider,
					)
				) {
					scopedModels.push({ model: providerMatch, thinkingLevel });
				}
				continue;
			}
			// No exact provider/model match - fall through to other matching
		}

		// Check for exact ID match (case-insensitive)
		const exactMatch = availableModels.find((m) => m.id.toLowerCase() === modelPattern.toLowerCase());
		if (exactMatch) {
			// Exact match found - use it directly
			if (!scopedModels.find((sm) => sm.model.id === exactMatch.id && sm.model.provider === exactMatch.provider)) {
				scopedModels.push({ model: exactMatch, thinkingLevel });
			}
			continue;
		}

		// No exact match - fall back to partial matching
		const matches = availableModels.filter(
			(m) =>
				m.id.toLowerCase().includes(modelPattern.toLowerCase()) ||
				m.name?.toLowerCase().includes(modelPattern.toLowerCase()),
		);

		if (matches.length === 0) {
			console.warn(chalk.yellow(`Warning: No models match pattern "${modelPattern}"`));
			continue;
		}

		// Helper to check if a model ID looks like an alias (no date suffix)
		// Dates are typically in format: -20241022 or -20250929
		const isAlias = (id: string): boolean => {
			// Check if ID ends with -latest
			if (id.endsWith("-latest")) return true;

			// Check if ID ends with a date pattern (-YYYYMMDD)
			const datePattern = /-\d{8}$/;
			return !datePattern.test(id);
		};

		// Separate into aliases and dated versions
		const aliases = matches.filter((m) => isAlias(m.id));
		const datedVersions = matches.filter((m) => !isAlias(m.id));

		let bestMatch: Model<Api>;

		if (aliases.length > 0) {
			// Prefer alias - if multiple aliases, pick the one that sorts highest
			aliases.sort((a, b) => b.id.localeCompare(a.id));
			bestMatch = aliases[0];
		} else {
			// No alias found, pick latest dated version
			datedVersions.sort((a, b) => b.id.localeCompare(a.id));
			bestMatch = datedVersions[0];
		}

		// Avoid duplicates
		if (!scopedModels.find((sm) => sm.model.id === bestMatch.id && sm.model.provider === bestMatch.provider)) {
			scopedModels.push({ model: bestMatch, thinkingLevel });
		}
	}

	return scopedModels;
}

async function selectSession(sessionManager: SessionManager): Promise<string | null> {
	return new Promise((resolve) => {
		const ui = new TUI(new ProcessTerminal());
		let resolved = false;

		const selector = new SessionSelectorComponent(
			sessionManager,
			(path: string) => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(path);
				}
			},
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(null);
				}
			},
		);

		ui.addChild(selector);
		ui.setFocus(selector.getSessionList());
		ui.start();
	});
}

async function runInteractiveMode(
	agent: Agent,
	sessionManager: SessionManager,
	settingsManager: SettingsManager,
	extensionManager: ExtensionManager,
	extensionLoader: ExtensionLoader,
	version: string,
	changelogMarkdown: string | null = null,
	modelFallbackMessage: string | null = null,
	newVersion: string | null = null,
	scopedModels: Array<{ model: Model<Api>; thinkingLevel: ThinkingLevel }> = [],
	toolSelector?: (model: Model<Api> | null | undefined) => ToolSelection,
	systemPromptBuilder?: (tools: Array<AgentTool<TSchema, unknown>>) => Promise<string>,
	initialMessages: string[] = [],
	initialMessage?: string,
	initialAttachments?: Attachment[],
	fdPath: string | null = null,
): Promise<void> {
	const renderer = new TuiRenderer(
		agent,
		sessionManager,
		settingsManager,
		extensionManager,
		extensionLoader,
		version,
		changelogMarkdown,
		newVersion,
		scopedModels,
		toolSelector,
		systemPromptBuilder,
		fdPath,
	);

	// Initialize TUI (subscribes to agent events internally)
	await renderer.init();

	// Keep runtime state updated with current model for tools (e.g., read_thread RAG)
	if (agent.state.model) {
		setCurrentModel(agent.state.model);
	}
	agent.subscribe((event) => {
		if (event.type === "turn_start" && agent.state.model) {
			setCurrentModel(agent.state.model);
		}
	});

	// Render any existing messages (from --continue mode)
	renderer.renderInitialMessages(agent.state);

	// Show model fallback warning at the end of the chat if applicable
	if (modelFallbackMessage) {
		renderer.showWarning(modelFallbackMessage);
	}

	// Process initial message with attachments if provided (from @file args)
	if (initialMessage) {
		try {
			await agent.prompt(initialMessage, initialAttachments);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			renderer.showError(errorMessage);
		}
	}

	// Process remaining initial messages if provided (from CLI args)
	for (const message of initialMessages) {
		try {
			await agent.prompt(message);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			renderer.showError(errorMessage);
		}
	}

	// Interactive loop
	while (true) {
		const userInput = await renderer.getUserInput();

		// Process the message - agent.prompt will add user message and trigger state updates
		try {
			await agent.prompt(userInput);
		} catch (error: unknown) {
			// Display error in the TUI by adding an error message to the chat
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			renderer.showError(errorMessage);
		}
	}
}

async function runSingleShotMode(
	agent: Agent,
	_sessionManager: SessionManager,
	messages: string[],
	mode: "text" | "json",
	initialMessage?: string,
	initialAttachments?: Attachment[],
): Promise<void> {
	// Keep runtime state updated with current model for tools (e.g., read_thread RAG)
	if (agent.state.model) {
		setCurrentModel(agent.state.model);
	}

	// Subscribe to track model changes during execution
	agent.subscribe((event) => {
		if (event.type === "turn_start" && agent.state.model) {
			setCurrentModel(agent.state.model);
		}
		// In JSON mode, also output events
		if (mode === "json") {
			console.log(JSON.stringify(event));
		}
	});

	// Send initial message with attachments if provided
	if (initialMessage) {
		await agent.prompt(initialMessage, initialAttachments);
	}

	// Send remaining messages
	for (const message of messages) {
		await agent.prompt(message);
	}

	// In text mode, only output the final assistant message
	if (mode === "text") {
		const lastMessage = agent.state.messages[agent.state.messages.length - 1];
		if (lastMessage.role === "assistant") {
			for (const content of lastMessage.content) {
				if (content.type === "text") {
					console.log(content.text);
				}
			}
		}
	}
}

async function runRpcMode(agent: Agent, sessionManager: SessionManager): Promise<void> {
	// Keep runtime state updated with current model for tools (e.g., read_thread RAG)
	if (agent.state.model) {
		setCurrentModel(agent.state.model);
	}

	// Subscribe to all events and output as JSON (same pattern as tui-renderer)
	agent.subscribe(async (event) => {
		if (event.type === "turn_start" && agent.state.model) {
			setCurrentModel(agent.state.model);
		}
		console.log(JSON.stringify(event));

		// Save messages to session
		if (event.type === "message_end") {
			sessionManager.saveMessage(event.message);

			// Yield to microtask queue to allow agent state to update
			// (tui-renderer does this implicitly via await handleEvent)
			await Promise.resolve();

			// Check if we should initialize session now (after first user+assistant exchange)
			if (sessionManager.shouldInitializeSession(agent.state.messages)) {
				sessionManager.startSession(agent.state);
			}
		}
	});

	// Listen for JSON input on stdin
	const readline = await import("readline");
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: false,
	});

	rl.on("line", async (line: string) => {
		try {
			const input = JSON.parse(line);

			// Handle different RPC commands
			if (input.type === "prompt" && input.message) {
				await agent.prompt(input.message, input.attachments);
			} else if (input.type === "abort") {
				agent.abort();
			}
		} catch (error: any) {
			// Output error as JSON
			console.log(JSON.stringify({ type: "error", error: error.message }));
		}
	});

	// Keep process alive
	return new Promise(() => {});
}

export async function main(args: string[]) {
	const parsed = parseArgs(args);

	if (parsed.version) {
		console.log(VERSION);
		return;
	}

	if (parsed.help) {
		printHelp();
		return;
	}

	// Handle --export flag: convert session file to HTML and exit
	if (parsed.export) {
		try {
			// Use first message as output path if provided
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			const result = exportFromFile(parsed.export, outputPath);
			console.log(`Exported to: ${result}`);
			return;
		} catch (error: any) {
			console.error(chalk.red(`Error: ${error.message || "Failed to export session"}`));
			process.exit(1);
		}
	}

	// Validate: RPC mode doesn't support @file arguments
	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	// Process @file arguments if any
	let initialMessage: string | undefined;
	let initialAttachments: Attachment[] | undefined;

	if (parsed.fileArgs.length > 0) {
		const { textContent, imageAttachments } = processFileArguments(parsed.fileArgs);

		// Combine file content with first plain text message (if any)
		if (parsed.messages.length > 0) {
			initialMessage = textContent + parsed.messages[0];
			parsed.messages.shift(); // Remove first message as it's been combined
		} else {
			initialMessage = textContent;
		}

		initialAttachments = imageAttachments.length > 0 ? imageAttachments : undefined;
	}

	// Initialize theme (before any TUI rendering)
	const settingsManager = new SettingsManager();
	initThemeWithGhostty(settingsManager);

	// Setup session manager
	const sessionManager = new SessionManager(parsed.continue && !parsed.resume, parsed.session);

	// Disable session saving if --no-session flag is set
	if (parsed.noSession) {
		sessionManager.disable();
	}

	// Handle resume: either by UUID or interactive selector
	if (parsed.resume) {
		if (parsed.resumeUuid) {
			// Resume by specific UUID: mu resume <uuid>
			const sessionPath = sessionManager.findSessionByUuid(parsed.resumeUuid);
			if (!sessionPath) {
				console.error(chalk.red(`Session not found: ${parsed.resumeUuid}`));
				console.error(chalk.dim("Use 'mu --resume' to browse available sessions"));
				process.exit(1);
			}
			sessionManager.setSessionFile(sessionPath);
		} else {
			// Interactive session selector: mu --resume or mu -r
			const selectedSession = await selectSession(sessionManager);
			if (!selectedSession) {
				console.log(chalk.dim("No session selected"));
				return;
			}
			sessionManager.setSessionFile(selectedSession);
		}
	}

	// Identity: expose session/run IDs via env for tools (Todo lock + assignment).
	ensureIdentityEnv(sessionManager.getSessionId());

	// Resolve model scope early if provided (needed for initial model selection)
	let scopedModels: Array<{ model: Model<Api>; thinkingLevel: ThinkingLevel }> = [];
	if (parsed.models && parsed.models.length > 0) {
		scopedModels = await resolveModelScope(parsed.models);
	}

	// Determine initial model using priority system:
	// 1. CLI args (--provider and --model)
	// 2. First model from --models scope
	// 3. Restored from session (if --continue or --resume)
	// 4. Saved default from settings.json
	// 5. First available model with valid API key
	// 6. null (allowed in interactive mode)
	let initialModel: Model<Api> | null = null;
	let initialThinking: ThinkingLevel = "off";

	if (parsed.provider && parsed.model) {
		// 1. CLI args take priority
		const { model, error } = findModel(parsed.provider, parsed.model);
		if (error) {
			console.error(chalk.red(error));
			process.exit(1);
		}
		if (!model) {
			console.error(chalk.red(`Model ${parsed.provider}/${parsed.model} not found`));
			process.exit(1);
		}
		initialModel = model;
	} else if (scopedModels.length > 0 && !parsed.continue && !parsed.resume) {
		// 2. Use first model from --models scope (skip if continuing/resuming session)
		initialModel = scopedModels[0].model;
		initialThinking = scopedModels[0].thinkingLevel;
	} else if (parsed.continue || parsed.resume) {
		// 3. Restore from session (will be handled below after loading session)
		// Leave initialModel as null for now
	}

	if (!initialModel) {
		// 3. Try saved default from settings
		const defaultProvider = settingsManager.getDefaultProvider();
		const defaultModel = settingsManager.getDefaultModel();
		if (defaultProvider && defaultModel) {
			const { model, error } = findModel(defaultProvider, defaultModel);
			if (error) {
				console.error(chalk.red(error));
				process.exit(1);
			}
			initialModel = model;

			// Also load saved thinking level if we're using saved model
			const savedThinking = settingsManager.getDefaultThinkingLevel();
			if (savedThinking) {
				initialThinking = savedThinking;
			}
		}
	}

	if (!initialModel) {
		// 4. Try first available model with valid API key
		// Prefer default model for each provider if available
		const { models: availableModels, error } = await getAvailableModels();

		if (error) {
			console.error(chalk.red(error));
			process.exit(1);
		}

		if (availableModels.length > 0) {
			// Try to find a default model from known providers
			for (const provider of Object.keys(defaultModelPerProvider) as KnownProvider[]) {
				const defaultModelId = defaultModelPerProvider[provider];
				const match = availableModels.find((m) => m.provider === provider && m.id === defaultModelId);
				if (match) {
					initialModel = match;
					break;
				}
			}

			// If no default found, use first available
			if (!initialModel) {
				initialModel = availableModels[0];
			}
		}
	}

	// Determine mode early to know if we should print messages and fail early
	// Interactive mode: no --print flag and no --mode flag
	// Having initial messages doesn't make it non-interactive anymore
	const isInteractive = !parsed.print && parsed.mode === undefined;
	const mode = parsed.mode || "text";
	// Only print informational messages in interactive mode
	// Non-interactive modes (-p, --mode json, --mode rpc) should be silent except for output
	const shouldPrintMessages = isInteractive;

	// Non-interactive mode: fail early if no model available
	if (!isInteractive && !initialModel) {
		console.error(chalk.red("No models available."));
		console.error(chalk.yellow("\nSet an API key environment variable:"));
		console.error("  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.");
		console.error(chalk.yellow("\nOr create ~/.mu/agent/models.json"));
		process.exit(1);
	}

	// Non-interactive mode: validate API key exists
	if (!isInteractive && initialModel) {
		const apiKey = parsed.apiKey || (await getApiKeyForModel(initialModel));
		if (!apiKey) {
			console.error(chalk.red(`No API key found for ${initialModel.provider}`));
			process.exit(1);
		}
	}

	// Load previous messages if continuing or resuming
	// This may update initialModel if restoring from session
	if (parsed.continue || parsed.resume) {
		// Load and restore model (overrides initialModel if found and has API key)
		const savedModel = sessionManager.loadModel();
		if (savedModel) {
			const { model: restoredModel, error } = findModel(savedModel.provider, savedModel.modelId);

			if (error) {
				console.error(chalk.red(error));
				process.exit(1);
			}

			// Check if restored model exists and has a valid API key
			const hasApiKey = restoredModel ? !!(await getApiKeyForModel(restoredModel)) : false;

			if (restoredModel && hasApiKey) {
				initialModel = restoredModel;
				if (shouldPrintMessages) {
					console.log(chalk.dim(`Restored model: ${savedModel.provider}/${savedModel.modelId}`));
				}
			} else {
				// Model not found or no API key - fall back to default selection
				const reason = !restoredModel ? "model no longer exists" : "no API key available";

				if (shouldPrintMessages) {
					console.error(
						chalk.yellow(
							`Warning: Could not restore model ${savedModel.provider}/${savedModel.modelId} (${reason}).`,
						),
					);
				}

				// Ensure we have a valid model - use the same fallback logic
				if (!initialModel) {
					const { models: availableModels, error: availableError } = await getAvailableModels();
					if (availableError) {
						console.error(chalk.red(availableError));
						process.exit(1);
					}
					if (availableModels.length > 0) {
						// Try to find a default model from known providers
						for (const provider of Object.keys(defaultModelPerProvider) as KnownProvider[]) {
							const defaultModelId = defaultModelPerProvider[provider];
							const match = availableModels.find((m) => m.provider === provider && m.id === defaultModelId);
							if (match) {
								initialModel = match;
								break;
							}
						}

						// If no default found, use first available
						if (!initialModel) {
							initialModel = availableModels[0];
						}

						if (initialModel && shouldPrintMessages) {
							console.log(chalk.dim(`Falling back to: ${initialModel.provider}/${initialModel.id}`));
						}
					} else {
						// No models available at all
						if (shouldPrintMessages) {
							console.error(chalk.red("\nNo models available."));
							console.error(chalk.yellow("Set an API key environment variable:"));
							console.error("  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.");
							console.error(chalk.yellow("\nOr create ~/.mu/agent/models.json"));
						}
						process.exit(1);
					}
				} else if (shouldPrintMessages) {
					console.log(chalk.dim(`Falling back to: ${initialModel.provider}/${initialModel.id}`));
				}
			}
		}
	}

	// CLI --thinking flag takes highest priority
	if (parsed.thinking) {
		initialThinking = parsed.thinking;
	}

	if (initialModel && initialThinking === "xhigh" && !supportsXhigh(initialModel)) {
		initialThinking = "high";
	}

	// ---------------------------------------------------------------------
	// Extensions (Phase 1+2): tools + tool interception + hot reload
	// ---------------------------------------------------------------------

	const extensionLog = (message: string, err?: unknown) => {
		if (!shouldPrintMessages) return;
		console.error(chalk.yellow(message));
		if (err) {
			console.error(chalk.dim(err instanceof Error ? err.stack || err.message : String(err)));
		}
	};

	const extensionManager = new ExtensionManager({
		builtInTools: allTools as unknown as Record<string, AgentTool<TSchema, unknown>>,
		log: extensionLog,
		sessionManager,
	});
	const extensionLoader = new ExtensionLoader(extensionManager, { log: extensionLog });
	await extensionLoader.loadAll();

	const baseToolNames = parsed.tools;
	const baseSelection = resolveToolSelection(baseToolNames, initialModel);
	const toolSelection: ToolSelection = {
		...baseSelection,
		tools: extensionManager.getToolsForSelection(baseSelection.toolNames),
	};
	const systemPrompt = await buildSystemPrompt(parsed.systemPrompt, toolSelection.tools);
	const selectedTools = toolSelection.tools;
	const toolSelector = (model: Model<Api> | null | undefined) => {
		const selection = resolveToolSelection(baseToolNames, model);
		return {
			...selection,
			tools: extensionManager.getToolsForSelection(selection.toolNames),
		};
	};
	const systemPromptBuilder = async (tools: Array<AgentTool<TSchema, unknown>>) =>
		buildSystemPrompt(parsed.systemPrompt, tools);

	// Create agent (initialModel can be null in interactive mode)
	const agent = new Agent({
		initialState: {
			systemPrompt,
			model: initialModel as any, // Can be null
			thinkingLevel: initialThinking,
			tools: selectedTools,
		},
		queueMode: settingsManager.getQueueMode(),
		messagePreprocessor: extensionManager.getMessagePreprocessor(),
		toolResultTransformer: extensionManager.composeToolResultTransformer(),
		transport: new ProviderTransport({
			// Dynamic API key lookup based on current model's provider
			getApiKey: async () => {
				const currentModel = agent.state.model;
				if (!currentModel) {
					throw new Error("No model selected");
				}

				// Try CLI override first
				if (parsed.apiKey) {
					return parsed.apiKey;
				}

				// Use model-specific key lookup
				const key = await getApiKeyForModel(currentModel);
				if (!key) {
					throw new Error(
						`No API key found for provider "${currentModel.provider}". Please set the appropriate environment variable or update ~/.mu/agent/models.json`,
					);
				}
				return key;
			},
		}),
	});

	// If initial thinking was requested but model doesn't support it, silently reset to off
	if (initialThinking !== "off" && initialModel && !initialModel.reasoning) {
		agent.setThinkingLevel("off");
	}

	if (initialModel && agent.state.thinkingLevel === "xhigh" && !supportsXhigh(initialModel)) {
		agent.setThinkingLevel("high");
	}

	// Track if we had to fall back from saved model (to show in chat later)
	let modelFallbackMessage: string | null = null;

	// Load previous messages if continuing or resuming
	if (parsed.continue || parsed.resume) {
		const messages = sessionManager.loadMessages();
		if (messages.length > 0) {
			agent.replaceMessages(messages);
		}

		// Load and restore thinking level
		const thinkingLevel = sessionManager.loadThinkingLevel() as ThinkingLevel;
		if (thinkingLevel) {
			agent.setThinkingLevel(thinkingLevel);
			if (shouldPrintMessages) {
				console.log(chalk.dim(`Restored thinking level: ${thinkingLevel}`));
			}
		}

		const activeModel = agent.state.model;
		if (activeModel && agent.state.thinkingLevel === "xhigh" && !supportsXhigh(activeModel)) {
			agent.setThinkingLevel("high");
		}

		// Check if we had to fall back from saved model
		const savedModel = sessionManager.loadModel();
		if (savedModel && initialModel) {
			const savedMatches = initialModel.provider === savedModel.provider && initialModel.id === savedModel.modelId;
			if (!savedMatches) {
				const { model: restoredModel, error } = findModel(savedModel.provider, savedModel.modelId);
				if (error) {
					// Config error - already shown above, just use generic message
					modelFallbackMessage = `Could not restore model ${savedModel.provider}/${savedModel.modelId}. Using ${initialModel.provider}/${initialModel.id}.`;
				} else {
					const reason = !restoredModel ? "model no longer exists" : "no API key available";
					modelFallbackMessage = `Could not restore model ${savedModel.provider}/${savedModel.modelId} (${reason}). Using ${initialModel.provider}/${initialModel.id}.`;
				}
			}
		}
	}

	// Log loaded context files (they're already in the system prompt)
	if (shouldPrintMessages && !parsed.continue && !parsed.resume) {
		const contextFiles = loadProjectContextFiles();
		if (contextFiles.length > 0) {
			console.log(chalk.dim("Loaded project context from:"));
			for (const { path: filePath } of contextFiles) {
				console.log(chalk.dim(`  - ${filePath}`));
			}
		}
	}

	// Route to appropriate mode
	if (mode === "rpc") {
		// RPC mode - headless operation
		await runRpcMode(agent, sessionManager);
	} else if (isInteractive) {
		// Skip version check - we're on a fork
		const newVersion: string | null = null;

		// Changelog popup disabled - use /changelog command to view
		const changelogMarkdown: string | null = null;

		// Show model scope if provided
		if (scopedModels.length > 0) {
			const modelList = scopedModels
				.map((sm) => {
					const thinkingStr = sm.thinkingLevel !== "off" ? `:${sm.thinkingLevel}` : "";
					return `${sm.model.id}${thinkingStr}`;
				})
				.join(", ");
			console.log(chalk.dim(`Model scope: ${modelList} ${chalk.gray("(Ctrl+P to cycle)")}`));
		}

		// Ensure fd tool is available for file autocomplete
		const fdPath = await ensureTool("fd");

		// Interactive mode - use TUI (may have initial messages from CLI args)
		await runInteractiveMode(
			agent,
			sessionManager,
			settingsManager,
			extensionManager,
			extensionLoader,
			VERSION,
			changelogMarkdown,
			modelFallbackMessage,
			newVersion,
			scopedModels,
			toolSelector,
			systemPromptBuilder,
			parsed.messages,
			initialMessage,
			initialAttachments,
			fdPath,
		);
	} else {
		// Non-interactive mode (--print flag or --mode flag)
		await runSingleShotMode(agent, sessionManager, parsed.messages, mode, initialMessage, initialAttachments);
	}
}
