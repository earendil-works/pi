import { calculateCost } from "../models.ts";
import type {
	ClassifierAnswer,
	ClassifierApi,
	ClassifierContext,
	ClassifierFunction,
	ClassifierModel,
	ClassifierOptions,
	ClassifierQuestion,
	ClassifierResult,
	Usage,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { isRecord, parseClassifierUsage, postClassifierRequest, requiredNumber } from "./classifier-shared.ts";

/**
 * pi-classifier API implementation.
 *
 * Sends pi's own classifier protocol directly to a backend: the request is a
 * single POST of `{ model, context, options }` to `<baseUrl>/classify`, and
 * a `200 OK` response is a completed `{ answers, usage?, responseModel?, responseId? }`
 * JSON object. Errors use non-2xx HTTP statuses with the `{ error: { message, code?, details? } }`
 * envelope, matching `pi-messages`.
 */

const LABEL = "Pi Classifier";

export interface PiClassifierOptions extends ClassifierOptions {
	/** Optional session identifier for gateway correlation/analytics. */
	sessionId?: string;
	/** Ask the backend for debug metadata (e.g. routing response headers). */
	debug?: boolean;
}

function wireOptions(options: PiClassifierOptions | undefined): Record<string, unknown> | undefined {
	if (!options) return undefined;
	const out: Record<string, unknown> = {};
	if (options.temperature !== undefined) out.temperature = options.temperature;
	if (options.sessionId !== undefined) out.sessionId = options.sessionId;
	return Object.keys(out).length > 0 ? out : undefined;
}

function finiteNonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function requiredUnitInterval(value: unknown, field: string): number {
	const num = requiredNumber(LABEL, value, field);
	if (num < 0 || num > 1) {
		throw new Error(`${LABEL} returned out-of-range ${field}: ${num}`);
	}
	return num;
}

function parseUsage(value: unknown, model: ClassifierModel<ClassifierApi>): Usage | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.input === "number" || typeof value.output === "number") {
		const input = finiteNonNegative(value.input);
		const output = finiteNonNegative(value.output);
		const cacheRead = finiteNonNegative(value.cacheRead);
		const cacheWrite = finiteNonNegative(value.cacheWrite);
		const totalTokens =
			typeof value.totalTokens === "number" && Number.isFinite(value.totalTokens) && value.totalTokens >= 0
				? value.totalTokens
				: input + output + cacheRead + cacheWrite;
		const usage: Usage = {
			input,
			output,
			cacheRead,
			cacheWrite,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		if (isRecord(value.cost) && typeof value.cost.total === "number" && Number.isFinite(value.cost.total)) {
			usage.cost = {
				input: finiteNonNegative(value.cost.input),
				output: finiteNonNegative(value.cost.output),
				cacheRead: finiteNonNegative(value.cost.cacheRead),
				cacheWrite: finiteNonNegative(value.cost.cacheWrite),
				total: finiteNonNegative(value.cost.total),
				...(typeof value.cost.totalFromProvider === "boolean"
					? { totalFromProvider: value.cost.totalFromProvider }
					: {}),
			};
		} else {
			calculateCost(model, usage);
		}
		return usage;
	}
	return parseClassifierUsage(value, model);
}

function parseProbabilities(value: unknown, id: string, criteria: Record<string, string>): Record<string, number> {
	if (!isRecord(value)) throw new Error(`${LABEL} returned invalid probabilities for ${id}`);
	return Object.fromEntries(
		Object.entries(value).map(([choice, prob]) => {
			if (!Object.hasOwn(criteria, choice)) {
				throw new Error(`${LABEL} returned unknown choice "${choice}" in probabilities for ${id}`);
			}
			return [choice, requiredUnitInterval(prob, `probability for ${id}.${choice}`)];
		}),
	);
}

function parseAnswer(id: string, question: ClassifierQuestion, answer: unknown): ClassifierAnswer {
	if (!isRecord(answer)) throw new Error(`${LABEL} returned an invalid answer for ${id}`);
	if (question.type === "choice") {
		if (answer.type !== "choice" || typeof answer.choice !== "string") {
			throw new Error(`${LABEL} did not return a choice answer for ${id}`);
		}
		if (!Object.hasOwn(question.criteria, answer.choice)) {
			throw new Error(`${LABEL} returned unknown choice "${answer.choice}" for ${id}`);
		}
		return {
			type: "choice",
			choice: answer.choice,
			probabilities: parseProbabilities(answer.probabilities, id, question.criteria),
			confidence: requiredUnitInterval(answer.confidence, `confidence for ${id}`),
		};
	}
	if (question.type === "score") {
		if (answer.type !== "score") throw new Error(`${LABEL} did not return a score answer for ${id}`);
		const score = requiredNumber(LABEL, answer.score, `score for ${id}`);
		const maxScore = Math.max(0, question.criteria.length - 1);
		if (score < 0 || score > maxScore) {
			throw new Error(`${LABEL} returned out-of-range score for ${id}: ${score}`);
		}
		return {
			type: "score",
			score,
			confidence: requiredUnitInterval(answer.confidence, `confidence for ${id}`),
		};
	}
	if (answer.type !== "bool") throw new Error(`${LABEL} did not return a bool answer for ${id}`);
	return { type: "bool", probability: requiredUnitInterval(answer.probability, `probability for ${id}`) };
}

function parseAnswers(value: unknown, context: ClassifierContext): Record<string, ClassifierAnswer> {
	if (!isRecord(value)) throw new Error(`${LABEL} returned an unexpected response`);
	return Object.fromEntries(
		Object.entries(context.questions).map(([id, question]) => {
			if (!Object.hasOwn(value, id)) throw new Error(`${LABEL} did not return an answer for ${id}`);
			return [id, parseAnswer(id, question, value[id])];
		}),
	);
}

/** Classification through pi's canonical `POST <baseUrl>/classify` protocol. */
export const classify: ClassifierFunction<PiClassifierOptions> = async (model, context, options) => {
	const output: ClassifierResult = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		if (model.api !== "pi-classifier") throw new Error(`Unsupported classifier API: ${model.api}`);
		if (context.images?.length) throw new Error(`${LABEL} does not support image input`);
		const url = new URL("classify", `${model.baseUrl.replace(/\/+$/u, "")}/`);
		if (options?.debug) url.searchParams.set("debug", "1");
		const requestOptions = wireOptions(options);
		const body = await postClassifierRequest(
			LABEL,
			url,
			model,
			{
				model: model.id,
				context: {
					state: context.state,
					questions: context.questions,
				},
				...(requestOptions ? { options: requestOptions } : {}),
			},
			options,
		);
		if (!isRecord(body)) throw new Error(`${LABEL} returned an unexpected response`);
		const usage = parseUsage(body.usage, model);
		if (usage) output.usage = usage;
		output.answers = parseAnswers(body.answers, context);
		return output;
	} catch (error) {
		output.answers = {};
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error), `${LABEL} error`);
		return output;
	}
};
