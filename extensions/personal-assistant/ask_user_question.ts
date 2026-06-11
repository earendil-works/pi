import { Type } from "typebox";

export type NormalizedOption = { label: string; description?: string };

export function normalizeOptions(input: unknown): NormalizedOption[] {
	// null/undefined → []
	if (input == null) return [];

	// Recursively unwrap .item until we hit an array
	let options: unknown = input;
	while (options != null && typeof options === 'object' && !Array.isArray(options) && 'item' in options) {
		options = (options as { item: unknown }).item;
	}

	// Not an array after unwrapping → []
	if (!Array.isArray(options)) return [];

	// Validate and normalize each item
	const result: NormalizedOption[] = [];
	for (const item of options) {
		if (item == null) continue;
		if (typeof item === 'string') {
			result.push({ label: item });
			continue;
		}
		if (typeof item !== 'object') continue;
		const obj = item as Record<string, unknown>;
		if (typeof obj.label !== 'string') continue;
		result.push({
			label: obj.label,
			description: typeof obj.description === 'string' ? obj.description : undefined,
		});
	}
	return result;
}

export function formatOptionForSelect(option: NormalizedOption): string {
	return option.description ? `${option.label} — ${option.description}` : option.label;
}

const parameters = Type.Object({
	question: Type.Optional(Type.String()),
	header: Type.Optional(Type.String()),
	options: Type.Any(), // intentionally loose — model hallucinates various shapes
	multiSelect: Type.Optional(Type.Boolean()),
});

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export function registerAskUserQuestion(pi: any): void {
	async function execute(
		_toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: any,
		ctx: any,
	) {
		const errorResult = (text: string) => ({
			content: [{ type: "text", text }],
			isError: true,
		});

		// 1. Validate question exists
		if (typeof params.question !== "string" || !params.question) {
			return errorResult("ask_user_question: missing or invalid 'question' field");
		}

		// 2. Normalize options
		const normalized = normalizeOptions(params.options);

		// 3. Validate 2-4 options
		if (normalized.length < 2 || normalized.length > 4) {
			return errorResult(
				`ask_user_question: options must contain between 2 and 4 items (got ${normalized.length})`,
			);
		}

		// 4. Build title/header and labels
		const title = params.header || params.question;
		const labels = normalized.map(formatOptionForSelect);
		const multiSelect = params.multiSelect === true;

		// 5. multiSelect → ctx.ui.input; single-select → ctx.ui.select
		if (multiSelect) {
			const placeholder = labels.join(" | ") + " (comma-separated)";
			const answer = await ctx.ui.input(title, placeholder, { timeout: TIMEOUT_MS });
			if (answer == null) {
				return {
					content: [{ type: "text", text: "User cancelled the question" }],
					details: { cancelled: true },
				};
			}
			const selected = answer.split(",").map((s: string) => s.trim()).filter(Boolean);
			return {
				content: [{ type: "text", text: `User selected: ${selected.join(", ")} (multi-select)` }],
				details: { selected, multiSelect: true },
			};
		} else {
			const answer = await ctx.ui.select(title, labels, { timeout: TIMEOUT_MS });
			if (answer == null) {
				return {
					content: [{ type: "text", text: "User cancelled the question" }],
					details: { cancelled: true },
				};
			}
			return {
				content: [{ type: "text", text: `User selected: ${answer}` }],
			};
		}
	}

	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User Question",
		description:
			"Ask the user to choose from a list of 2-4 options. Use this when you need a decision before continuing.",
		promptSnippet: "Ask the user to choose from 2-4 options to gather a decision.",
		parameters,
		execute,
	});
}
