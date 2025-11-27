import { Agent, ProviderTransport, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, KnownProvider, Model } from "@mariozechner/pi-ai";
import { ProcessTerminal, TUI } from "@mariozechner/pi-tui";
import chalk from "chalk";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { getChangelogPath, getNewEntries, parseChangelog } from "./changelog.js";
import { findModel, getApiKeyForModel, getAvailableModels } from "./model-config.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { initTheme } from "./theme/theme.js";
import { codingTools } from "./tools/index.js";
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
	google: "gemini-2.5-pro",
	openrouter: "openai/gpt-5.1-codex",
	xai: "grok-4-fast-non-reasoning",
	groq: "openai/gpt-oss-120b",
	cerebras: "zai-glm-4.6",
	zai: "glm-4.6",
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
	help?: boolean;
	mode?: Mode;
	noSession?: boolean;
	session?: string;
	models?: string[];
	print?: boolean;
	messages: string[];
}

function parseArgs(args: string[]): Args {
	const result: Args = {
		messages: [],
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--mode" && i + 1 < args.length) {
			const mode = args[++i];
			if (mode === "text" || mode === "json" || mode === "rpc") {
				result.mode = mode;
			}
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--resume" || arg === "-r") {
			result.resume = true;
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
		} else if (!arg.startsWith("-")) {
			result.messages.push(arg);
		}
	}

	return result;
}

function printHelp() {
	console.log(`${chalk.bold("pi")} - AI coding assistant with read, bash, edit, write tools

${chalk.bold("Usage:")}
  pi [options] [messages...]

${chalk.bold("Options:")}
  --provider <name>       Provider name (default: google)
  --model <id>            Model ID (default: gemini-2.5-flash)
  --api-key <key>         API key (defaults to env vars)
  --system-prompt <text>  System prompt (default: coding assistant prompt)
  --mode <mode>           Output mode: text (default), json, or rpc
  --print, -p             Non-interactive mode: process prompt and exit
  --continue, -c          Continue previous session
  --resume, -r            Select a session to resume
  --session <path>        Use specific session file
  --no-session            Don't save session (ephemeral)
  --models <patterns>     Comma-separated model patterns for quick cycling with Ctrl+P
  --thinking <level>      Set thinking level: off, minimal, low, medium, high
  --help, -h              Show this help

${chalk.bold("Examples:")}
  # Interactive mode
  pi

  # Interactive mode with initial prompt
  pi "List all .ts files in src/"

  # Non-interactive mode (process and exit)
  pi -p "List all .ts files in src/"

  # Multiple messages (interactive)
  pi "Read package.json" "What dependencies do we have?"

  # Continue previous session
  pi --continue "What did we discuss?"

  # Use different model
  pi --provider openai --model gpt-4o-mini "Help me refactor this code"

  # Limit model cycling to specific models
  pi --models claude-sonnet,claude-haiku,gpt-4o

  # Cycle models with fixed thinking levels
  pi --models sonnet:high,haiku:low

  # Start with a specific thinking level
  pi --thinking high "Solve this complex problem"

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
  PI_CODING_AGENT_DIR     - Session storage directory (default: ~/.pi/agent)

${chalk.bold("Available Tools:")}
  read   - Read file contents
  bash   - Execute bash commands
  edit   - Edit files with find/replace
  write  - Write files (creates/overwrites)
`);
}

function buildSystemPrompt(customPrompt?: string): string {
	// Check if customPrompt is a file path that exists
	if (customPrompt && existsSync(customPrompt)) {
		try {
			customPrompt = readFileSync(customPrompt, "utf-8");
		} catch (error) {
			console.error(chalk.yellow(`Warning: Could not read system prompt file ${customPrompt}: ${error}`));
			// Fall through to use as literal string
		}
	}

	if (customPrompt) {
		// Use custom prompt as base, then add context/datetime
		const now = new Date();
		const dateTime = now.toLocaleString("en-US", {
			weekday: "long",
			year: "numeric",
			month: "long",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			timeZoneName: "short",
		});

		let prompt = customPrompt;

		// Append project context files
		const contextFiles = loadProjectContextFiles();
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "The following project context files have been loaded:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		// Add date/time and working directory last
		prompt += `\nCurrent date and time: ${dateTime}`;
		prompt += `\nCurrent working directory: ${process.cwd()}`;

		return prompt;
	}

	const now = new Date();
	const dateTime = now.toLocaleString("en-US", {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		timeZoneName: "short",
	});

	// Get absolute path to README.md
	const readmePath = resolve(join(__dirname, "../README.md"));

	let prompt = `You are actually not Claude, you are Pi. You are an expert coding assistant. You help users with coding tasks by reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make surgical edits to files (find exact text and replace)
- write: Create or overwrite files

Guidelines:
- Always use bash tool for file operations like ls, grep, find
- Use read to examine files before editing
- Use edit for precise changes (old text must match exactly)
- Use write only for new files or complete rewrites
- Be concise in your responses
- Show file paths clearly when working with files
- When summarizing your actions, output plain text directly - do NOT use cat or bash to display what you did

Documentation:
- Your own documentation (including custom model setup and theme creation) is at: ${readmePath}
- Read it when users ask about features, configuration, or setup, and especially if the user asks you to add a custom model or provider, or create a custom theme.`;

	// Append project context files
	const contextFiles = loadProjectContextFiles();
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "The following project context files have been loaded:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	// Add date/time and working directory last
	prompt += `\nCurrent date and time: ${dateTime}`;
	prompt += `\nCurrent working directory: ${process.cwd()}`;

	return prompt;
}

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
 * 1. Global: ~/.pi/agent/AGENTS.md or CLAUDE.md
 * 2. Parent directories (top-most first) down to cwd
 * Each returns {path, content} for separate messages
 */
function loadProjectContextFiles(): Array<{ path: string; content: string }> {
	const contextFiles: Array<{ path: string; content: string }> = [];

	// 1. Load global context from ~/.pi/agent/
	const homeDir = homedir();
	const globalContextDir = resolve(process.env.PI_CODING_AGENT_DIR || join(homeDir, ".pi/agent/"));
	const globalContext = loadContextFileFromDir(globalContextDir);
	if (globalContext) {
		contextFiles.push(globalContext);
	}

	// 2. Walk up from cwd to root, collecting all context files
	const cwd = process.cwd();
	const ancestorContextFiles: Array<{ path: string; content: string }> = [];

	let currentDir = cwd;
	const root = resolve("/");

	while (true) {
		const contextFile = loadContextFileFromDir(currentDir);
		if (contextFile) {
			// Add to beginning so we get top-most parent first
			ancestorContextFiles.unshift(contextFile);
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
		const response = await fetch("https://registry.npmjs.org/@mariozechner/pi-coding-agent/latest");
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
	version: string,
	changelogMarkdown: string | null = null,
	modelFallbackMessage: string | null = null,
	newVersion: string | null = null,
	scopedModels: Array<{ model: Model<Api>; thinkingLevel: ThinkingLevel }> = [],
	initialMessages: string[] = [],
): Promise<void> {
	const renderer = new TuiRenderer(
		agent,
		sessionManager,
		settingsManager,
		version,
		changelogMarkdown,
		newVersion,
		scopedModels,
	);

	// Initialize TUI (subscribes to agent events internally)
	await renderer.init();

	// Render any existing messages (from --continue mode)
	renderer.renderInitialMessages(agent.state);

	// Show model fallback warning at the end of the chat if applicable
	if (modelFallbackMessage) {
		renderer.showWarning(modelFallbackMessage);
	}

	// Process initial messages if provided (from CLI args)
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
): Promise<void> {
	if (mode === "json") {
		// Subscribe to all events and output as JSON
		agent.subscribe((event) => {
			// Output event as JSON (same format as session manager)
			console.log(JSON.stringify(event));
		});
	}

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

async function runRpcMode(agent: Agent, _sessionManager: SessionManager): Promise<void> {
	// Subscribe to all events and output as JSON
	agent.subscribe((event) => {
		console.log(JSON.stringify(event));
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

	if (parsed.help) {
		printHelp();
		return;
	}

	// Initialize theme (before any TUI rendering)
	const settingsManager = new SettingsManager();
	const themeName = settingsManager.getTheme();
	initTheme(themeName);

	// Setup session manager
	const sessionManager = new SessionManager(parsed.continue && !parsed.resume, parsed.session);

	// Disable session saving if --no-session flag is set
	if (parsed.noSession) {
		sessionManager.disable();
	}

	// Handle --resume flag: show session selector
	if (parsed.resume) {
		const selectedSession = await selectSession(sessionManager);
		if (!selectedSession) {
			console.log(chalk.dim("No session selected"));
			return;
		}
		// Set the selected session as the active session
		sessionManager.setSessionFile(selectedSession);
	}

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
		console.error(chalk.yellow("\nOr create ~/.pi/agent/models.json"));
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

	const systemPrompt = buildSystemPrompt(parsed.systemPrompt);

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
							console.error(chalk.yellow("\nOr create ~/.pi/agent/models.json"));
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

	// Create agent (initialModel can be null in interactive mode)
	const agent = new Agent({
		initialState: {
			systemPrompt,
			model: initialModel as any, // Can be null
			thinkingLevel: initialThinking,
			tools: codingTools,
		},
		queueMode: settingsManager.getQueueMode(),
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
						`No API key found for provider "${currentModel.provider}". Please set the appropriate environment variable or update ~/.pi/agent/models.json`,
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
		// Check for new version (don't block startup if it takes too long)
		let newVersion: string | null = null;
		try {
			newVersion = await Promise.race([
				checkForNewVersion(VERSION),
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)), // 1 second timeout
			]);
		} catch (e) {
			// Ignore errors
		}

		// Check if we should show changelog (only in interactive mode, only for new sessions)
		let changelogMarkdown: string | null = null;
		if (!parsed.continue && !parsed.resume) {
			const lastVersion = settingsManager.getLastChangelogVersion();

			// Check if we need to show changelog
			if (!lastVersion) {
				// First run - show all entries
				const changelogPath = getChangelogPath();
				const entries = parseChangelog(changelogPath);
				if (entries.length > 0) {
					changelogMarkdown = entries.map((e) => e.content).join("\n\n");
					settingsManager.setLastChangelogVersion(VERSION);
				}
			} else {
				// Parse current and last versions
				const changelogPath = getChangelogPath();
				const entries = parseChangelog(changelogPath);
				const newEntries = getNewEntries(entries, lastVersion);

				if (newEntries.length > 0) {
					changelogMarkdown = newEntries.map((e) => e.content).join("\n\n");
					settingsManager.setLastChangelogVersion(VERSION);
				}
			}
		}

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

		// Interactive mode - use TUI (may have initial messages from CLI args)
		await runInteractiveMode(
			agent,
			sessionManager,
			settingsManager,
			VERSION,
			changelogMarkdown,
			modelFallbackMessage,
			newVersion,
			scopedModels,
			parsed.messages,
		);
	} else {
		// Non-interactive mode (--print flag or --mode flag)
		await runSingleShotMode(agent, sessionManager, parsed.messages, mode);
	}
}
