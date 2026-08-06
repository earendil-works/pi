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
	narrative?: boolean;
}

function parseArgs(args: string[]): CliOptions {
	const options: CliOptions = {};
	for (let index = 0; index < args.length; index++) {
		switch (args[index]) {
			case "--base-url":
				options.baseUrl = args[++index];
				break;
			case "--api-key":
				options.apiKey = args[++index];
				break;
			case "--model":
				options.model = args[++index];
				break;
			case "--api":
				options.api = args[++index];
				break;
			case "--provider":
				options.provider = args[++index];
				break;
			case "--system-prompt":
				options.systemPrompt = args[++index];
				break;
			case "--memory-dir":
				options.memoryDir = args[++index];
				break;
			case "--summary-interval":
				options.summaryInterval = Number(args[++index]);
				break;
			case "--narrative":
				options.narrative = true;
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
		narrative: options.narrative,
	};
}

const server = startStdioServer();
const options = parseArgs(process.argv.slice(2));
const config = buildConfig(options);
if (config) {
	void server.handleRequest({ type: "init", config });
}
