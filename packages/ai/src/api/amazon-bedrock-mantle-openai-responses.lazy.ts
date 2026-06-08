import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

const importNodeOnlyApi = (specifier: string): Promise<unknown> => {
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	return import(runtimeSpecifier);
};

let amazonBedrockMantleOpenAIResponsesModuleOverride: ProviderStreams | undefined;

export function setAmazonBedrockMantleOpenAIResponsesProviderModule(module: ProviderStreams): void {
	amazonBedrockMantleOpenAIResponsesModuleOverride = module;
}

export const amazonBedrockMantleOpenAIResponsesApi = (): ProviderStreams =>
	lazyApi(
		async () =>
			amazonBedrockMantleOpenAIResponsesModuleOverride ??
			((await importNodeOnlyApi("./amazon-bedrock-mantle-openai-responses.ts")) as ProviderStreams),
	);
