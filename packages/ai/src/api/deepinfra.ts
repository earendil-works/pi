// Shared DeepInfra constants and catalog-response shape used by the provider
// factory (src/providers/deepinfra.ts) and both model-generation scripts.
export const DEEPINFRA_BASE_URL = "https://api.deepinfra.com/v1/openai";
export const DEEPINFRA_MODELS_URL = `${DEEPINFRA_BASE_URL}/models?filter=with_meta&sort_by=pi`;

/** A single entry from the DeepInfra OpenAI-compatible catalog endpoint. */
export interface DeepInfraCatalogModel {
	id: string;
	metadata?: {
		context_length?: number;
		max_tokens?: number;
		pricing?: {
			input_tokens?: number;
			output_tokens?: number;
			cache_read_tokens?: number;
		};
		tags?: string[];
	};
}
