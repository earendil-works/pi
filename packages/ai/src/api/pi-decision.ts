import type {
	ClassifierAnswer,
	ClassifierContext,
	ClassifierFunction,
	ClassifierOptions,
	ClassifierQuestion,
	ClassifierResult,
	Usage,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { isRecord, postClassifierRequest, requiredNumber } from "./classifier-shared.ts";
import { parsePiUsage } from "./json-request.ts";

/**
 * pi-decision API implementation.
 *
 * Sends pi's own decision protocol directly to a backend: the request is a
 * single POST of `{ model, context, options }` to `<baseUrl>/decision`, and
 * a `200 OK` response is a completed `{ answers, usage?, responseId? }` JSON object. Errors
 * use non-2xx HTTP statuses with the `{ error: { message, code?, details? } }`
 * envelope, matching `pi-messages`.
 */

const LABEL = "Pi Decision";

export interface PiDecisionOptions extends ClassifierOptions {
	/** Optional session identifier for gateway correlation/analytics. */
	sessionId?: string;
}

/** Wire request body sent by `pi-decision` to `POST <baseUrl>/decision`. */
export type PiDecisionRequest = {
	model: string;
	context: ClassifierContext;
	options?: {
		sessionId?: string;
	};
};

/** Wire response body returned by a `pi-decision` backend on `200 OK`. */
export type PiDecisionResponse = {
	answers: Record<string, ClassifierAnswer>;
	usage?: Usage;
	responseId?: string;
};

function requiredUnitInterval(value: unknown, field: string): number {
	const num = requiredNumber(LABEL, value, field);
	if (num < 0 || num > 1) {
		throw new Error(`${LABEL} returned out-of-range ${field}: ${num}`);
	}
	return num;
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

/** Classification through pi's canonical `POST <baseUrl>/decision` protocol. */
export const classify: ClassifierFunction<PiDecisionOptions> = async (model, context, options) => {
	const output: ClassifierResult = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		if (model.api !== "pi-decision") throw new Error(`Unsupported classifier API: ${model.api}`);
		const images = context.images ?? [];
		if (images.length > 0 && !model.input.includes("image")) {
			throw new Error(`${LABEL} model ${model.id} does not support image input`);
		}
		const url = new URL("decision", `${model.baseUrl.replace(/\/+$/u, "")}/`);
		const requestBody: PiDecisionRequest = {
			model: model.id,
			context: {
				state: context.state,
				...(images.length > 0 ? { images } : {}),
				questions: context.questions,
			},
			...(options?.sessionId !== undefined ? { options: { sessionId: options.sessionId } } : {}),
		};
		const body = await postClassifierRequest(LABEL, url, model, requestBody, options);
		if (!isRecord(body)) throw new Error(`${LABEL} returned an unexpected response`);
		if (typeof body.responseId === "string" && body.responseId) output.responseId = body.responseId;
		const usage = parsePiUsage(body.usage, model);
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
