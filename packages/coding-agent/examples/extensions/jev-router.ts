/**
 * Jev router - a virtual model that plans on a strong model and implements on a cheap one.
 *
 * Registers `jev/auto`, which routes between three OpenAI Codex models:
 *
 * - Planning: GPT-5.6 Sol for complex work, GPT-5.6 Terra otherwise. The Jev classifier rates the
 *   first user message; planning stays on the chosen model.
 * - Implementation: GPT-5.6 Luna.
 *
 * The planning model explores, plans, and makes the first edit. After the first successful `edit`
 * or `write` tool call, the next request of the same turn goes to Luna, and the session stays
 * there. A session therefore switches models once and accepts a single prompt-cache miss.
 *
 * The phase is stored in `jev-route` custom entries, so it follows the session tree and survives
 * compaction. The selected thinking level passes through as the reasoning effort of the chosen
 * model. Requests outside the agent loop, such as compaction summaries, go to Luna.
 *
 * Requires TypeSafe credentials (TYPESAFE_API_KEY) and an OpenAI Codex login.
 * Usage: pi -e ./jev-router.ts --model jev/auto
 */

import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";

const PROVIDER = "openai-codex";
const SOL = "gpt-5.6-sol";
const TERRA = "gpt-5.6-terra";
const LUNA = "gpt-5.6-luna";

/** Tools whose successful result means implementation has started. */
const EDIT_TOOLS = new Set(["edit", "write"]);

/** Data of a `jev-route` session entry. */
interface JevRoute {
	phase: "planning" | "implementation";
	/** OpenAI Codex model for this phase. */
	model: string;
}

function latestRoute(ctx: ExtensionContext): JevRoute | undefined {
	let latest: JevRoute | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === "jev-route") latest = entry.data as JevRoute;
	}
	return latest;
}

function routeTo(request: ModelRouteRequest, ctx: ExtensionContext, id: string): ModelRoute {
	const model = ctx.modelRegistry.find(PROVIDER, id);
	if (!model) throw new Error(`Model ${PROVIDER}/${id} is not in the catalog`);
	return { model, thinkingLevel: request.thinkingLevel };
}

function lastUserText(messages: readonly Message[]): string {
	const content = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** Planning model for a new session: Sol for complex work, Terra otherwise or when Jev is unavailable. */
async function choosePlanningModel(request: ModelRouteRequest, ctx: ExtensionContext): Promise<string> {
	// Keep a planning model the session already uses, so switching to jev/auto costs no cache miss.
	const previous = request.previous?.model;
	if (previous?.provider === PROVIDER && (previous.id === SOL || previous.id === TERRA)) return previous.id;

	const jev = ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest");
	if (!jev) return TERRA;
	const result = await ctx.modelRegistry.classify(
		jev,
		{
			state: { prompt: lastUserText(request.messages).slice(0, 16_000) },
			questions: {
				complexity: {
					type: "choice",
					instructions: "How demanding is the software engineering work requested in `prompt`?",
					criteria: {
						standard: "Ordinary features, fixes, reviews, or questions",
						complex: "Subtle design, cross-cutting changes, or hard debugging",
					},
				},
			},
		},
		{ signal: request.signal },
	);
	const answer = result.stopReason === "stop" ? result.answers.complexity : undefined;
	return answer?.type === "choice" && (answer.probabilities.complex ?? 0) >= 0.5 ? SOL : TERRA;
}

export default function (pi: ExtensionAPI) {
	pi.registerVirtualModel({
		provider: "jev",
		id: "auto",
		name: "Auto (Jev)",
		thinkingLevels: ["low", "medium", "high", "xhigh"],
		// Shared by all three models; shown before the first response.
		contextWindow: 272_000,
		maxTokens: 128_000,
		async route(request, ctx) {
			let model = request.reason === "direct" ? LUNA : latestRoute(ctx)?.model;
			if (!model) {
				model = await choosePlanningModel(request, ctx);
				pi.appendEntry<JevRoute>("jev-route", { phase: "planning", model });
			}
			return routeTo(request, ctx, model);
		},
	});

	// The planning model made the first edit: hand the rest of the work to Luna.
	pi.on("turn_end", (event, ctx) => {
		if (ctx.model?.provider !== "jev" || latestRoute(ctx)?.phase !== "planning") return undefined;
		if (!event.toolResults.some((result) => EDIT_TOOLS.has(result.toolName) && !result.isError)) return undefined;
		const data: JevRoute = { phase: "implementation", model: LUNA };
		return { entries: [{ type: "custom", customType: "jev-route", data }] };
	});
}
