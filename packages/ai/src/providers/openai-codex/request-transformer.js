/**
 * Request transformation for Codex API.
 */
function clampReasoningEffort(model, effort) {
	// Codex backend expects exact model IDs. Do not normalize model names here.
	const modelId = model.includes("/") ? model.split("/").pop() : model;
	// gpt-5.1 does not support xhigh.
	if (modelId === "gpt-5.1" && effort === "xhigh") {
		return "high";
	}
	// gpt-5.1-codex-mini only supports medium/high.
	if (modelId === "gpt-5.1-codex-mini") {
		return effort === "high" || effort === "xhigh" ? "high" : "medium";
	}
	return effort;
}
function getReasoningConfig(model, options) {
	return {
		effort: clampReasoningEffort(model, options.reasoningEffort),
		summary: options.reasoningSummary ?? "auto",
	};
}
function filterInput(input) {
	if (!Array.isArray(input)) return input;
	return input
		.filter((item) => item.type !== "item_reference")
		.map((item) => {
			if (item.id != null) {
				const { id: _id, ...rest } = item;
				return rest;
			}
			return item;
		});
}
export async function transformRequestBody(body, options = {}, prompt) {
	body.store = false;
	body.stream = true;
	if (body.input && Array.isArray(body.input)) {
		body.input = filterInput(body.input);
		if (body.input) {
			const functionCallIds = new Set(
				body.input
					.filter((item) => item.type === "function_call" && typeof item.call_id === "string")
					.map((item) => item.call_id),
			);
			body.input = body.input.map((item) => {
				if (item.type === "function_call_output" && typeof item.call_id === "string") {
					const callId = item.call_id;
					if (!functionCallIds.has(callId)) {
						const itemRecord = item;
						const toolName = typeof itemRecord.name === "string" ? itemRecord.name : "tool";
						let text = "";
						try {
							const output = itemRecord.output;
							text = typeof output === "string" ? output : JSON.stringify(output);
						} catch {
							text = String(itemRecord.output ?? "");
						}
						if (text.length > 16000) {
							text = `${text.slice(0, 16000)}\n...[truncated]`;
						}
						return {
							type: "message",
							role: "assistant",
							content: `[Previous ${toolName} result; call_id=${callId}]: ${text}`,
						};
					}
				}
				return item;
			});
		}
	}
	if (prompt?.developerMessages && prompt.developerMessages.length > 0 && Array.isArray(body.input)) {
		const developerMessages = prompt.developerMessages.map((text) => ({
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text }],
		}));
		body.input = [...developerMessages, ...body.input];
	}
	if (options.reasoningEffort !== undefined) {
		const reasoningConfig = getReasoningConfig(body.model, options);
		body.reasoning = {
			...body.reasoning,
			...reasoningConfig,
		};
	} else {
		delete body.reasoning;
	}
	const modelId = body.model.includes("/") ? body.model.split("/").pop() : body.model;
	const defaultVerbosity = modelId.includes("codex") ? "medium" : "high";
	body.text = {
		...body.text,
		verbosity: options.textVerbosity || defaultVerbosity,
	};
	const include = Array.isArray(options.include) ? [...options.include] : [];
	include.push("reasoning.encrypted_content");
	body.include = Array.from(new Set(include));
	delete body.max_output_tokens;
	delete body.max_completion_tokens;
	return body;
}
//# sourceMappingURL=request-transformer.js.map
