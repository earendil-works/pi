import chalk from "chalk";
import { getActivePod, loadConfig } from "../config.js";

// ────────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────────

interface PromptOptions {
	pod?: string;
	apiKey?: string;
}

// ────────────────────────────────────────────────────────────────────────────────
// Main prompt function
// ────────────────────────────────────────────────────────────────────────────────

export async function promptModel(modelName: string, userArgs: string[], opts: PromptOptions = {}) {
	// Get pod and model configuration
	const activePod = opts.pod ? { name: opts.pod, pod: loadConfig().pods[opts.pod] } : getActivePod();

	if (!activePod) {
		console.error(chalk.red("No active pod. Use 'mu pods active <name>' to set one."));
		process.exit(1);
	}

	const { name: podName, pod } = activePod;
	const modelConfig = pod.models[modelName];

	if (!modelConfig) {
		console.error(chalk.red(`Model '${modelName}' not found on pod '${podName}'`));
		process.exit(1);
	}

	// Extract host from SSH string
	const host =
		pod.ssh
			.split(" ")
			.find((p) => p.includes("@"))
			?.split("@")[1] ?? "localhost";

	// Build the system prompt for code navigation
	const systemPrompt = `You help the user understand and navigate the codebase in the current working directory.

You can read files, list directories, and execute shell commands via the respective tools.

Do not output file contents you read via the read_file tool directly, unless asked to.

Do not output markdown tables as part of your responses.

Keep your responses concise and relevant to the user's request.

File paths you output must include line numbers where possible, e.g. "src/index.ts:10-20" for lines 10 to 20 in src/index.ts.

Current working directory: ${process.cwd()}`;

	// Build arguments for agent main function
	const args: string[] = [];

	// Add base configuration that we control
	args.push(
		"--base-url",
		`http://${host}:${modelConfig.port}/v1`,
		"--model",
		modelConfig.model,
		"--api-key",
		opts.apiKey || process.env.MU_API_KEY || "dummy",
		"--api",
		modelConfig.model.toLowerCase().includes("gpt-oss") ? "responses" : "completions",
		"--system-prompt",
		systemPrompt,
	);

	// Pass through all user-provided arguments
	// This includes messages, --continue, --json, etc.
	args.push(...userArgs);

	// Call agent main function directly
	try {
		throw new Error("Not implemented");
	} catch (err: any) {
		console.error(chalk.red(`Agent error: ${err.message}`));
		process.exit(1);
	}
}
