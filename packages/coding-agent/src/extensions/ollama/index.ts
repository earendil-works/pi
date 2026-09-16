import { ollamaProvider } from "@earendil-works/pi-ai/providers/ollama";
import type { ExtensionAPI } from "../../core/extensions/types.ts";

export default function ollamaExtension(pi: ExtensionAPI): void {
	pi.registerProvider(ollamaProvider());
	pi.registerCommand("ollama", {
		description: "Refresh installed Ollama models (configure with /login ollama)",
		handler: async (_args, ctx) => {
			if (!(await ctx.modelRegistry.getProviderAuth("ollama"))) {
				ctx.ui.notify("Configure Ollama with /login ollama or OLLAMA_BASE_URL", "warning");
				return;
			}
			const result = await ctx.modelRegistry.refresh({ providers: ["ollama"], signal: AbortSignal.timeout(15_000) });
			const error = result.errors.get("ollama");
			if (error || result.aborted) ctx.ui.notify(error?.message ?? "Ollama discovery timed out", "error");
			else ctx.ui.notify("Ollama model catalog refreshed. Select a model with /model.");
		},
	});
}
