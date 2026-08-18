/**
 * CLI argument parsing and help display
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { t } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR } from "../config.ts";
import type { ExtensionFlag } from "../core/extensions/types.ts";
import type { TuiMode } from "../core/settings-manager.ts";

export type Mode = "text" | "json" | "rpc";

export interface Args {
	provider?: string;
	model?: string;
	apiKey?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	thinking?: ThinkingLevel;
	continue?: boolean;
	resume?: boolean;
	help?: boolean;
	version?: boolean;
	mode?: Mode;
	name?: string;
	noSession?: boolean;
	session?: string;
	sessionId?: string;
	fork?: string;
	sessionDir?: string;
	models?: string[];
	tools?: string[];
	excludeTools?: string[];
	noTools?: boolean;
	noBuiltinTools?: boolean;
	extensions?: string[];
	noExtensions?: boolean;
	print?: boolean;
	export?: string;
	noSkills?: boolean;
	skills?: string[];
	promptTemplates?: string[];
	noPromptTemplates?: boolean;
	themes?: string[];
	useTheme?: string;
	noThemes?: boolean;
	noContextFiles?: boolean;
	listModels?: string | true;
	offline?: boolean;
	tuiMode?: TuiMode;
	verbose?: boolean;
	projectTrustOverride?: boolean;
	messages: string[];
	fileArgs: string[];
	/** Unknown flags (potentially extension flags) - map of flag name to value */
	unknownFlags: Map<string, boolean | string>;
	diagnostics: Array<{ type: "warning" | "error"; message: string }>;
}

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
	return VALID_THINKING_LEVELS.includes(level as ThinkingLevel);
}

export function normalizeSessionName(value: string): string | undefined {
	const name = value.trim();
	return name.length > 0 ? name : undefined;
}

export function parseArgs(args: string[]): Args {
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
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
		} else if (arg === "--provider" && i + 1 < args.length) {
			result.provider = args[++i];
		} else if (arg === "--model" && i + 1 < args.length) {
			result.model = args[++i];
		} else if (arg === "--api-key" && i + 1 < args.length) {
			result.apiKey = args[++i];
		} else if (arg === "--system-prompt" && i + 1 < args.length) {
			result.systemPrompt = args[++i];
		} else if (arg === "--append-system-prompt" && i + 1 < args.length) {
			result.appendSystemPrompt = result.appendSystemPrompt ?? [];
			result.appendSystemPrompt.push(args[++i]);
		} else if (arg === "--name" || arg === "-n") {
			if (i + 1 < args.length) {
				result.name = args[++i];
			} else {
				result.diagnostics.push({ type: "error", message: t("codingAgent.cli.errors.nameRequiresValue") });
			}
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--session" && i + 1 < args.length) {
			result.session = args[++i];
		} else if (arg === "--session-id" && i + 1 < args.length) {
			result.sessionId = args[++i];
		} else if (arg === "--fork" && i + 1 < args.length) {
			result.fork = args[++i];
		} else if (arg === "--session-dir" && i + 1 < args.length) {
			result.sessionDir = args[++i];
		} else if (arg === "--models" && i + 1 < args.length) {
			result.models = args[++i].split(",").map((s) => s.trim());
		} else if (arg === "--no-tools" || arg === "-nt") {
			result.noTools = true;
		} else if (arg === "--no-builtin-tools" || arg === "-nbt") {
			result.noBuiltinTools = true;
		} else if ((arg === "--tools" || arg === "-t") && i + 1 < args.length) {
			result.tools = args[++i]
				.split(",")
				.map((s) => s.trim())
				.filter((name) => name.length > 0);
		} else if ((arg === "--exclude-tools" || arg === "-xt") && i + 1 < args.length) {
			result.excludeTools = args[++i]
				.split(",")
				.map((s) => s.trim())
				.filter((name) => name.length > 0);
		} else if (arg === "--thinking" && i + 1 < args.length) {
			const level = args[++i];
			if (isValidThinkingLevel(level)) {
				result.thinking = level;
			} else {
				result.diagnostics.push({
					type: "warning",
					message: t("codingAgent.cli.errors.invalidThinkingLevel", {
						level,
						validValues: VALID_THINKING_LEVELS.join(", "),
					}),
				});
			}
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) {
				result.messages.push(next);
				i++;
			}
		} else if (arg === "--export" && i + 1 < args.length) {
			result.export = args[++i];
		} else if ((arg === "--extension" || arg === "-e") && i + 1 < args.length) {
			result.extensions = result.extensions ?? [];
			result.extensions.push(args[++i]);
		} else if (arg === "--no-extensions" || arg === "-ne") {
			result.noExtensions = true;
		} else if (arg === "--skill" && i + 1 < args.length) {
			result.skills = result.skills ?? [];
			result.skills.push(args[++i]);
		} else if (arg === "--prompt-template" && i + 1 < args.length) {
			result.promptTemplates = result.promptTemplates ?? [];
			result.promptTemplates.push(args[++i]);
		} else if (arg === "--theme" && i + 1 < args.length) {
			result.themes = result.themes ?? [];
			result.themes.push(args[++i]);
		} else if (arg === "--use-theme") {
			const themeName = args[i + 1];
			if (themeName === undefined || themeName.startsWith("-")) {
				result.diagnostics.push({ type: "error", message: t("codingAgent.cli.errors.useThemeRequiresName") });
			} else {
				result.useTheme = themeName;
				i++;
			}
		} else if (arg === "--no-skills" || arg === "-ns") {
			result.noSkills = true;
		} else if (arg === "--no-prompt-templates" || arg === "-np") {
			result.noPromptTemplates = true;
		} else if (arg === "--no-themes") {
			result.noThemes = true;
		} else if (arg === "--no-context-files" || arg === "-nc") {
			result.noContextFiles = true;
		} else if (arg === "--list-models") {
			// Check if next arg is a search pattern (not a flag or file arg)
			if (i + 1 < args.length && !args[i + 1].startsWith("-") && !args[i + 1].startsWith("@")) {
				result.listModels = args[++i];
			} else {
				result.listModels = true;
			}
		} else if (arg === "--tui-mode") {
			const mode = args[i + 1];
			if (mode === "regular" || mode === "fullscreen") {
				result.tuiMode = mode;
				i++;
			} else if (mode === undefined || mode.startsWith("-")) {
				result.diagnostics.push({ type: "error", message: t("codingAgent.cli.errors.tuiModeRequiresValue") });
			} else {
				i++;
				result.diagnostics.push({
					type: "error",
					message: t("codingAgent.cli.errors.invalidTuiMode", { mode }),
				});
			}
		} else if (arg === "--verbose") {
			result.verbose = true;
		} else if (arg === "--approve" || arg === "-a") {
			result.projectTrustOverride = true;
		} else if (arg === "--no-approve" || arg === "-na") {
			result.projectTrustOverride = false;
		} else if (arg === "--offline") {
			result.offline = true;
		} else if (arg.startsWith("@")) {
			result.fileArgs.push(arg.slice(1)); // Remove @ prefix
		} else if (arg.startsWith("--")) {
			const eqIndex = arg.indexOf("=");
			if (eqIndex !== -1) {
				result.unknownFlags.set(arg.slice(2, eqIndex), arg.slice(eqIndex + 1));
			} else {
				const flagName = arg.slice(2);
				const next = args[i + 1];
				if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
					result.unknownFlags.set(flagName, next);
					i++;
				} else {
					result.unknownFlags.set(flagName, true);
				}
			}
		} else if (arg.startsWith("-") && !arg.startsWith("--")) {
			result.diagnostics.push({
				type: "error",
				message: t("codingAgent.cli.errors.unknownOption", { option: arg }),
			});
		} else if (!arg.startsWith("-")) {
			result.messages.push(arg);
		}
	}

	return result;
}

export function printHelp(extensionFlags?: ExtensionFlag[]): void {
	const extensionFlagsText =
		extensionFlags && extensionFlags.length > 0
			? `\n${chalk.bold(t("codingAgent.cli.extensionFlags"))}\n${extensionFlags
					.map((flag) => {
						const value = flag.type === "string" ? " <value>" : "";
						const description =
							flag.description ?? t("codingAgent.cli.registeredBy", { path: flag.extensionPath });
						return `  --${flag.name}${value}`.padEnd(30) + description;
					})
					.join("\n")}\n`
			: "";

	const commands = [
		`  ${APP_NAME} install <source> [-l]     ${t("codingAgent.cli.help.install")}`,
		`  ${APP_NAME} remove <source> [-l]      ${t("codingAgent.cli.help.remove")}`,
		`  ${APP_NAME} uninstall <source> [-l]   ${t("codingAgent.cli.help.uninstall")}`,
		`  ${APP_NAME} update [source|self|pi]   ${t("codingAgent.cli.help.update")}`,
		`  ${APP_NAME} list                      ${t("codingAgent.cli.help.list")}`,
		`  ${APP_NAME} config [-l]               ${t("codingAgent.cli.help.config")}`,
		`  ${APP_NAME} auth <command>            ${t("codingAgent.cli.help.auth")}`,
		`  ${APP_NAME} <command> --help          ${t("codingAgent.cli.help.help")}`,
	].join("\n");

	const options = [
		`  --provider <name>              ${t("codingAgent.cli.optionsText.provider")}`,
		`  --model <pattern>              ${t("codingAgent.cli.optionsText.model")}`,
		`  --api-key <key>                ${t("codingAgent.cli.optionsText.apiKey")}`,
		`  --system-prompt <text>         ${t("codingAgent.cli.optionsText.systemPrompt")}`,
		`  --append-system-prompt <text>  ${t("codingAgent.cli.optionsText.appendSystemPrompt")}`,
		`  --mode <mode>                  ${t("codingAgent.cli.optionsText.mode")}`,
		`  --print, -p                    ${t("codingAgent.cli.optionsText.print")}`,
		`  --continue, -c                 ${t("codingAgent.cli.optionsText.continue")}`,
		`  --resume, -r                   ${t("codingAgent.cli.optionsText.resume")}`,
		`  --session <path|id>            ${t("codingAgent.cli.optionsText.session")}`,
		`  --session-id <id>              ${t("codingAgent.cli.optionsText.sessionId")}`,
		`  --fork <path|id>               ${t("codingAgent.cli.optionsText.fork")}`,
		`  --session-dir <dir>            ${t("codingAgent.cli.optionsText.sessionDir")}`,
		`  --no-session                   ${t("codingAgent.cli.optionsText.noSession")}`,
		`  --name, -n <name>              ${t("codingAgent.cli.optionsText.name")}`,
		`  --models <patterns>            ${t("codingAgent.cli.optionsText.models")}`,
		`  --no-tools, -nt                ${t("codingAgent.cli.optionsText.noTools")}`,
		`  --no-builtin-tools, -nbt       ${t("codingAgent.cli.optionsText.noBuiltinTools")}`,
		`  --tools, -t <tools>            ${t("codingAgent.cli.optionsText.tools")}`,
		`  --exclude-tools, -xt <tools>   ${t("codingAgent.cli.optionsText.excludeTools")}`,
		`  --thinking <level>             ${t("codingAgent.cli.optionsText.thinking")}`,
		`  --extension, -e <path>         ${t("codingAgent.cli.optionsText.extension")}`,
		`  --no-extensions, -ne           ${t("codingAgent.cli.optionsText.noExtensions")}`,
		`  --skill <path>                 ${t("codingAgent.cli.optionsText.skill")}`,
		`  --no-skills, -ns               ${t("codingAgent.cli.optionsText.noSkills")}`,
		`  --prompt-template <path>       ${t("codingAgent.cli.optionsText.promptTemplate")}`,
		`  --no-prompt-templates, -np     ${t("codingAgent.cli.optionsText.noPromptTemplates")}`,
		`  --theme <path>                 ${t("codingAgent.cli.optionsText.theme")}`,
		`  --use-theme <name[/name]>      ${t("codingAgent.cli.optionsText.useTheme")}`,
		`  --no-themes                    ${t("codingAgent.cli.optionsText.noThemes")}`,
		`  --no-context-files, -nc        ${t("codingAgent.cli.optionsText.noContextFiles")}`,
		`  --export <file>                ${t("codingAgent.cli.optionsText.export")}`,
		`  --list-models [search]         ${t("codingAgent.cli.optionsText.listModels")}`,
		`  --verbose                      ${t("codingAgent.cli.optionsText.verbose")}`,
		`  --tui-mode <mode>              ${t("codingAgent.cli.optionsText.tuiMode")}`,
		`  --approve, -a                  ${t("codingAgent.cli.optionsText.approve")}`,
		`  --no-approve, -na              ${t("codingAgent.cli.optionsText.noApprove")}`,
		`  --offline                      ${t("codingAgent.cli.optionsText.offline")}`,
		`  --help, -h                     ${t("codingAgent.cli.optionsText.helpFlag")}`,
		`  --version, -v                  ${t("codingAgent.cli.optionsText.version")}`,
	].join("\n");

	const examples = [
		`  # ${t("codingAgent.cli.examples.printApiKey")}`,
		`  ${APP_NAME} auth print-api-key --provider openai`,
		"",
		`  # ${t("codingAgent.cli.examples.printBearerToken")}`,
		`  ${APP_NAME} auth print-bearer-token --provider openai-codex`,
		"",
		`  # ${t("codingAgent.cli.examples.interactive")}`,
		`  ${APP_NAME}`,
		"",
		`  # ${t("codingAgent.cli.examples.interactiveWithPrompt")}`,
		`  ${APP_NAME} "List all .ts files in src/"`,
		"",
		`  # ${t("codingAgent.cli.examples.includeFiles")}`,
		`  ${APP_NAME} @prompt.md @image.png "What color is the sky?"`,
		"",
		`  # ${t("codingAgent.cli.examples.nonInteractive")}`,
		`  ${APP_NAME} -p "List all .ts files in src/"`,
		"",
		`  # ${t("codingAgent.cli.examples.multipleMessages")}`,
		`  ${APP_NAME} "Read package.json" "What dependencies do we have?"`,
		"",
		`  # ${t("codingAgent.cli.examples.continueSession")}`,
		`  ${APP_NAME} --continue "What did we discuss?"`,
		"",
		`  # ${t("codingAgent.cli.examples.namedSession")}`,
		`  ${APP_NAME} --name "Refactor auth module"`,
		"",
		`  # ${t("codingAgent.cli.examples.differentModel")}`,
		`  ${APP_NAME} --provider openai --model gpt-4o-mini "Help me refactor this code"`,
		"",
		`  # ${t("codingAgent.cli.examples.modelWithProvider")}`,
		`  ${APP_NAME} --model openai/gpt-4o "Help me refactor this code"`,
		"",
		`  # ${t("codingAgent.cli.examples.modelWithThinking")}`,
		`  ${APP_NAME} --model sonnet:high "Solve this complex problem"`,
		"",
		`  # ${t("codingAgent.cli.examples.limitCycling")}`,
		`  ${APP_NAME} --models claude-sonnet,claude-haiku,gpt-4o`,
		"",
		`  # ${t("codingAgent.cli.examples.globPattern")}`,
		`  ${APP_NAME} --models "github-copilot/*"`,
		"",
		`  # ${t("codingAgent.cli.examples.fixedThinking")}`,
		`  ${APP_NAME} --models sonnet:high,haiku:low`,
		"",
		`  # ${t("codingAgent.cli.examples.specificThinking")}`,
		`  ${APP_NAME} --thinking high "Solve this complex problem"`,
		"",
		`  # ${t("codingAgent.cli.examples.readOnly")}`,
		`  ${APP_NAME} --tools read,grep,find,ls -p "Review the code in src/"`,
		"",
		`  # ${t("codingAgent.cli.examples.excludeTool")}`,
		`  ${APP_NAME} --exclude-tools ask_question`,
		"",
		`  # ${t("codingAgent.cli.examples.exportHtml")}`,
		`  ${APP_NAME} --export ~/${CONFIG_DIR_NAME}/agent/sessions/--path--/session.jsonl`,
		`  ${APP_NAME} --export session.jsonl output.html`,
	].join("\n");

	const toolsList = [
		`  read   - ${t("codingAgent.cli.toolsList.read")}`,
		`  bash   - ${t("codingAgent.cli.toolsList.bash")}`,
		`  edit   - ${t("codingAgent.cli.toolsList.edit")}`,
		`  write  - ${t("codingAgent.cli.toolsList.write")}`,
		`  grep   - ${t("codingAgent.cli.toolsList.grep")}`,
		`  find   - ${t("codingAgent.cli.toolsList.find")}`,
		`  ls     - ${t("codingAgent.cli.toolsList.ls")}`,
	].join("\n");

	console.log(`${chalk.bold(APP_NAME)} - ${t("codingAgent.cli.description")}

${chalk.bold(t("codingAgent.cli.usage"))}
  ${APP_NAME} [options] [@files...] [messages...]

${chalk.bold(t("codingAgent.cli.commands"))}
${commands}

${chalk.bold(t("codingAgent.cli.options"))}
${options}

${t("codingAgent.cli.extensionFlagsHint")}${extensionFlagsText}

${chalk.bold(t("codingAgent.cli.examplesHeader"))}
${examples}

${chalk.bold(t("codingAgent.cli.envVars"))}
  ANTHROPIC_AUTH_TOKEN             - Anthropic bearer auth token
  ANTHROPIC_API_KEY                - Anthropic Claude API key
  ANTHROPIC_OAUTH_TOKEN            - Anthropic OAuth token (alternative to API key)
  ANT_LING_API_KEY                 - Ant Ling API key
  OPENAI_API_KEY                   - OpenAI GPT API key
  AZURE_OPENAI_API_KEY             - Azure OpenAI API key
  AZURE_OPENAI_BASE_URL            - Azure OpenAI/Cognitive Services base URL (e.g. https://{resource}.openai.azure.com)
  AZURE_OPENAI_RESOURCE_NAME       - Azure OpenAI resource name (alternative to base URL)
  AZURE_OPENAI_API_VERSION         - Azure OpenAI API version (default: v1)
  AZURE_OPENAI_DEPLOYMENT_NAME_MAP - Azure OpenAI model=deployment map (comma-separated)
  DEEPSEEK_API_KEY                 - DeepSeek API key
  NVIDIA_API_KEY                   - NVIDIA NIM API key
  GEMINI_API_KEY                   - Google Gemini API key
  GROQ_API_KEY                     - Groq API key
  CEREBRAS_API_KEY                 - Cerebras API key
  XAI_API_KEY                      - xAI Grok API key
  FIREWORKS_API_KEY                - Fireworks API key
  TOGETHER_API_KEY                 - Together AI API key
  BASETEN_API_KEY                  - Baseten API key
  OPENROUTER_API_KEY               - OpenRouter API key
  AI_GATEWAY_API_KEY               - Vercel AI Gateway API key
  ZAI_API_KEY                      - ZAI Coding Plan API key (Global)
  ZAI_CODING_CN_API_KEY            - ZAI Coding Plan API key (China)
  MISTRAL_API_KEY                  - Mistral API key
  MINIMAX_API_KEY                  - MiniMax API key
  MOONSHOT_API_KEY                 - Moonshot AI API key
  OPENCODE_API_KEY                 - OpenCode Zen/OpenCode Go API key
  KIMI_API_KEY                     - Kimi For Coding API key
  CLOUDFLARE_API_KEY               - Cloudflare API token (Workers AI and AI Gateway)
  CLOUDFLARE_ACCOUNT_ID            - Cloudflare account id (required for both)
  CLOUDFLARE_GATEWAY_ID            - Cloudflare AI Gateway slug (required for AI Gateway)
  QWEN_TOKEN_PLAN_API_KEY          - Qwen Token Plan API key (international region)
  QWEN_TOKEN_PLAN_CN_API_KEY       - Qwen Token Plan API key (China region)
  XIAOMI_API_KEY                   - Xiaomi MiMo API key (api.xiaomimimo.com billing)
  XIAOMI_TOKEN_PLAN_CN_API_KEY     - Xiaomi MiMo Token Plan API key (China region)
  XIAOMI_TOKEN_PLAN_AMS_API_KEY    - Xiaomi MiMo Token Plan API key (Amsterdam region)
  XIAOMI_TOKEN_PLAN_SGP_API_KEY    - Xiaomi MiMo Token Plan API key (Singapore region)
  AWS_PROFILE                      - AWS profile for Amazon Bedrock
  AWS_ACCESS_KEY_ID                - AWS access key for Amazon Bedrock
  AWS_SECRET_ACCESS_KEY            - AWS secret key for Amazon Bedrock
  AWS_BEARER_TOKEN_BEDROCK         - Bedrock API key (bearer token)
  AWS_REGION                       - AWS region for Amazon Bedrock (e.g., us-east-1)
  ${ENV_AGENT_DIR.padEnd(32)} - Config directory (default: ~/${CONFIG_DIR_NAME}/agent)
  ${ENV_SESSION_DIR.padEnd(32)} - Session storage directory (overridden by --session-dir)
  PI_PACKAGE_DIR                   - Override package directory (for Nix/Guix store paths)
  PI_OFFLINE                       - Disable startup network operations when set to 1/true/yes
  PI_TELEMETRY                     - Override install telemetry when set to 1/true/yes or 0/false/no
  PI_SHARE_VIEWER_URL              - Base URL for /share command (default: https://pi.dev/session/)

${chalk.bold(t("codingAgent.cli.tools"))}
${toolsList}
`);
}
