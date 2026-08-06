import { type RpConfig, type RpModelConfig, startStdioServer } from "./index.ts";

interface CliOptions {
	baseUrl?: string;
	apiKey?: string;
	model?: string;
	api?: string;
	provider?: string;
	systemPrompt?: string;
	memoryDir?: string;
	summaryInterval?: number;
}

function parseArgs(args: string[]): CliOptions {
	const options: CliOptions = {};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		const value = args[index + 1];
		if (value === undefined) {
			continue;
		}
		switch (arg) {
			case "--base-url":
				options.baseUrl = value;
				index++;
				break;
			case "--api-key":
				options.apiKey = value;
				index++;
				break;
			case "--model":
				options.model = value;
				index++;
				break;
			case "--api":
				options.api = value;
				index++;
				break;
			case "--provider":
				options.provider = value;
				index++;
				break;
			case "--system-prompt":
				options.systemPrompt = value;
				index++;
				break;
			case "--memory-dir":
				options.memoryDir = value;
				index++;
				break;
			case "--summary-interval":
				options.summaryInterval = Number(value);
				index++;
				break;
		}
	}
	return options;
}

function buildConfig(options: CliOptions): RpConfig | undefined {
	if (!options.model || !options.baseUrl) {
		return undefined;
	}
	const modelConfig: RpModelConfig = {
		id: options.model,
		api: options.api,
		provider: options.provider,
		baseUrl: options.baseUrl,
		apiKey: options.apiKey,
	};
	return {
		model: modelConfig,
		systemPrompt: options.systemPrompt,
		memoryDir: options.memoryDir,
		summaryInterval: options.summaryInterval,
	};
}

const server = startStdioServer();
const options = parseArgs(process.argv.slice(2));
const config = buildConfig(options);
if (config) {
	void server.handleRequest({ type: "init", config });
}
