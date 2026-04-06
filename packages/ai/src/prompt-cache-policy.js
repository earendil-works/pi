import { createHash } from "node:crypto";

function sortToolsDeterministically(tools) {
	if (!tools) return undefined;
	return [...tools].sort((left, right) => left.name.localeCompare(right.name));
}
function fingerprint(content) {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
function splitSystemPromptIntoLayers(systemPrompt) {
	if (!systemPrompt) {
		return { system: "", context: "" };
	}
	const closingTag = "</system_instructions>";
	const closingIndex = systemPrompt.indexOf(closingTag);
	if (closingIndex === -1) {
		return { system: systemPrompt, context: "" };
	}
	const systemEnd = closingIndex + closingTag.length;
	const system = systemPrompt.slice(0, systemEnd).trim();
	const context = systemPrompt.slice(systemEnd).trim();
	return { system, context };
}
function serializeTools(tools) {
	if (!tools || tools.length === 0) return "";
	return JSON.stringify(
		tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		})),
	);
}
function serializeMessages(messages) {
	return JSON.stringify(messages);
}
function buildPromptCacheLayers(context) {
	const { system, context: volatileContext } = splitSystemPromptIntoLayers(context.systemPrompt);
	const tools = sortToolsDeterministically(context.tools);
	const layers = [
		{
			id: "system",
			stability: "stable",
			content: system,
			fingerprint: fingerprint(system),
		},
		{
			id: "tools",
			stability: "stable",
			content: serializeTools(tools),
			fingerprint: fingerprint(serializeTools(tools)),
		},
		{
			id: "context",
			stability: "volatile",
			content: volatileContext,
			fingerprint: fingerprint(volatileContext),
		},
		{
			id: "history",
			stability: "volatile",
			content: serializeMessages(context.messages),
			fingerprint: fingerprint(serializeMessages(context.messages)),
		},
	];
	return layers;
}
function getProviderCacheKey(model, sessionId) {
	if (!sessionId) return undefined;
	if (model.api === "openai-codex-responses") return sessionId;
	return undefined;
}
export function planPromptCachePolicy(args) {
	const tools = sortToolsDeterministically(args.context.tools);
	const normalizedContext = {
		...args.context,
		tools,
	};
	const layers = buildPromptCacheLayers(normalizedContext);
	const stablePrefixFingerprint = fingerprint(
		layers
			.filter((layer) => layer.stability === "stable")
			.map((layer) => `${layer.id}:${layer.fingerprint}`)
			.join("|"),
	);
	return {
		context: normalizedContext,
		provider: {
			cacheKey: getProviderCacheKey(args.model, args.sessionId),
		},
		layers,
		stablePrefixFingerprint,
	};
}
//# sourceMappingURL=prompt-cache-policy.js.map
