// pi-ai's built-in providers for a session's worker, each loaded on its first use (`loadProvider`): a worker holds
// only the providers of the logins it uses, never the whole catalog (all of them at once cost about 12 MiB more per
// worker than one; slayer, Node 26, 2026-11-26).

import type { Provider } from "@earendil-works/pi-ai";

/** Built-in provider `id`, loaded and made on first use; `undefined` for an id pi-ai has no provider of. */
export async function loadProvider(id: string): Promise<Provider | undefined> {
	return Object.hasOwn(BUILT_IN, id) ? BUILT_IN[id]!() : undefined;
}

/** Each built-in provider's module, by provider id (the module's name), and its factory. */
const BUILT_IN: Readonly<Record<string, () => Promise<Provider>>> = {
	"amazon-bedrock": async () =>
		(await import("@earendil-works/pi-ai/providers/amazon-bedrock")).amazonBedrockProvider(),
	"ant-ling": async () => (await import("@earendil-works/pi-ai/providers/ant-ling")).antLingProvider(),
	anthropic: async () => (await import("@earendil-works/pi-ai/providers/anthropic")).anthropicProvider(),
	azure: async () => (await import("@earendil-works/pi-ai/providers/azure")).azureProvider(),
	baseten: async () => (await import("@earendil-works/pi-ai/providers/baseten")).basetenProvider(),
	cerebras: async () => (await import("@earendil-works/pi-ai/providers/cerebras")).cerebrasProvider(),
	"cloudflare-ai-gateway": async () =>
		(await import("@earendil-works/pi-ai/providers/cloudflare-ai-gateway")).cloudflareAIGatewayProvider(),
	"cloudflare-workers-ai": async () =>
		(await import("@earendil-works/pi-ai/providers/cloudflare-workers-ai")).cloudflareWorkersAIProvider(),
	deepseek: async () => (await import("@earendil-works/pi-ai/providers/deepseek")).deepseekProvider(),
	fireworks: async () => (await import("@earendil-works/pi-ai/providers/fireworks")).fireworksProvider(),
	"github-copilot": async () =>
		(await import("@earendil-works/pi-ai/providers/github-copilot")).githubCopilotProvider(),
	google: async () => (await import("@earendil-works/pi-ai/providers/google")).googleProvider(),
	"google-vertex": async () => (await import("@earendil-works/pi-ai/providers/google-vertex")).googleVertexProvider(),
	groq: async () => (await import("@earendil-works/pi-ai/providers/groq")).groqProvider(),
	huggingface: async () => (await import("@earendil-works/pi-ai/providers/huggingface")).huggingfaceProvider(),
	"kimi-coding": async () => (await import("@earendil-works/pi-ai/providers/kimi-coding")).kimiCodingProvider(),
	meta: async () => (await import("@earendil-works/pi-ai/providers/meta")).metaProvider(),
	minimax: async () => (await import("@earendil-works/pi-ai/providers/minimax")).minimaxProvider(),
	"minimax-cn": async () => (await import("@earendil-works/pi-ai/providers/minimax-cn")).minimaxCnProvider(),
	mistral: async () => (await import("@earendil-works/pi-ai/providers/mistral")).mistralProvider(),
	moonshotai: async () => (await import("@earendil-works/pi-ai/providers/moonshotai")).moonshotaiProvider(),
	"moonshotai-cn": async () => (await import("@earendil-works/pi-ai/providers/moonshotai-cn")).moonshotaiCnProvider(),
	nvidia: async () => (await import("@earendil-works/pi-ai/providers/nvidia")).nvidiaProvider(),
	openai: async () => (await import("@earendil-works/pi-ai/providers/openai")).openaiProvider(),
	"openai-codex": async () => (await import("@earendil-works/pi-ai/providers/openai-codex")).openaiCodexProvider(),
	opencode: async () => (await import("@earendil-works/pi-ai/providers/opencode")).opencodeProvider(),
	"opencode-go": async () => (await import("@earendil-works/pi-ai/providers/opencode-go")).opencodeGoProvider(),
	openrouter: async () => (await import("@earendil-works/pi-ai/providers/openrouter")).openrouterProvider(),
	"qwen-token-plan": async () =>
		(await import("@earendil-works/pi-ai/providers/qwen-token-plan")).qwenTokenPlanProvider(),
	"qwen-token-plan-cn": async () =>
		(await import("@earendil-works/pi-ai/providers/qwen-token-plan-cn")).qwenTokenPlanCnProvider(),
	"qwen-token-plan-individual": async () =>
		(await import("@earendil-works/pi-ai/providers/qwen-token-plan-individual")).qwenTokenPlanIndividualProvider(),
	"qwen-token-plan-individual-cn": async () =>
		(
			await import("@earendil-works/pi-ai/providers/qwen-token-plan-individual-cn")
		).qwenTokenPlanIndividualCnProvider(),
	radius: async () => (await import("@earendil-works/pi-ai/providers/radius")).radiusProvider(),
	together: async () => (await import("@earendil-works/pi-ai/providers/together")).togetherProvider(),
	typesafe: async () => (await import("@earendil-works/pi-ai/providers/typesafe")).typesafeProvider(),
	"vercel-ai-gateway": async () =>
		(await import("@earendil-works/pi-ai/providers/vercel-ai-gateway")).vercelAIGatewayProvider(),
	xai: async () => (await import("@earendil-works/pi-ai/providers/xai")).xaiProvider(),
	xiaomi: async () => (await import("@earendil-works/pi-ai/providers/xiaomi")).xiaomiProvider(),
	"xiaomi-token-plan-ams": async () =>
		(await import("@earendil-works/pi-ai/providers/xiaomi-token-plan-ams")).xiaomiTokenPlanAmsProvider(),
	"xiaomi-token-plan-cn": async () =>
		(await import("@earendil-works/pi-ai/providers/xiaomi-token-plan-cn")).xiaomiTokenPlanCnProvider(),
	"xiaomi-token-plan-sgp": async () =>
		(await import("@earendil-works/pi-ai/providers/xiaomi-token-plan-sgp")).xiaomiTokenPlanSgpProvider(),
	zai: async () => (await import("@earendil-works/pi-ai/providers/zai")).zaiProvider(),
	"zai-coding-cn": async () => (await import("@earendil-works/pi-ai/providers/zai-coding-cn")).zaiCodingCnProvider(),
};
