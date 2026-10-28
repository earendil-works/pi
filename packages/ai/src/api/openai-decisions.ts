import type {
	ClassifierAnswer,
	ClassifierContext,
	ClassifierFunction,
	ClassifierOptions,
	ClassifierQuestion,
	ClassifierResult,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import {
	type ClassifierHttpError,
	isRecord,
	parseClassifierUsage,
	postClassifierRequest,
	requiredNumber,
} from "./classifier-shared.ts";

/**
 * OpenAI's Decisions API: `POST /v1/decisions` with `{ model, input, questions }`.
 * https://developers.openai.com/api/docs/guides/decisions
 *
 * The state is sent as JSON text. With images, the input becomes one user message with the state
 * as `input_text` followed by `input_image` data URLs. Questions map to Decisions types:
 * `choice` to `choice`, `score` to `score`, and `bool` to `predicate`. Predicates have no
 * criteria field, so the meanings of true and false are appended to the instructions.
 *
 * Only OpenAI API keys work: Sign in with ChatGPT tokens are rejected on this route.
 */

const LABEL = "OpenAI Decisions";

/** The endpoint accepts at most this many image parts per request. */
const MAX_IMAGES = 128;

interface DecisionQuestion {
	type: "predicate" | "choice" | "score";
	name: string;
	instructions: string;
	choices?: Array<{ value: string; description?: string }>;
	levels?: Array<{ label: string }>;
}

function predicateInstructions(question: Extract<ClassifierQuestion, { type: "bool" }>): string {
	const meanings = [
		question.criteria.true ? `True means: ${question.criteria.true}` : "",
		question.criteria.false ? `False means: ${question.criteria.false}` : "",
	].filter(Boolean);
	return meanings.length > 0 ? `${question.instructions}\n\n${meanings.join("\n")}` : question.instructions;
}

function wireQuestion(name: string, question: ClassifierQuestion): DecisionQuestion {
	if (question.type === "choice") {
		return {
			type: "choice",
			name,
			instructions: question.instructions,
			choices: Object.entries(question.criteria).map(([value, description]) =>
				description ? { value, description } : { value },
			),
		};
	}
	if (question.type === "score") {
		return {
			type: "score",
			name,
			instructions: question.instructions,
			levels: question.criteria.map((label) => ({ label })),
		};
	}
	return { type: "predicate", name, instructions: predicateInstructions(question) };
}

function wireInput(context: ClassifierContext): unknown {
	const state = JSON.stringify(context.state);
	const images = context.images ?? [];
	if (images.length === 0) return state;
	if (images.length > MAX_IMAGES) {
		throw new Error(`${LABEL} accepts at most ${MAX_IMAGES} images, got ${images.length}`);
	}
	return [
		{
			role: "user",
			content: [
				{ type: "input_text", text: state },
				...images.map((image) => ({
					type: "input_image",
					image_url: `data:${image.mimeType};base64,${image.data}`,
				})),
			],
		},
	];
}

function choiceProbabilities(value: unknown, id: string): Record<string, number> {
	if (!Array.isArray(value)) throw new Error(`${LABEL} returned invalid probabilities for ${id}`);
	return Object.fromEntries(
		value.map((entry) => {
			if (!isRecord(entry) || typeof entry.value !== "string") {
				throw new Error(`${LABEL} returned invalid probabilities for ${id}`);
			}
			return [entry.value, requiredNumber(LABEL, entry.probability, `probability for ${id}.${entry.value}`)];
		}),
	);
}

function parseAnswer(id: string, question: ClassifierQuestion, answer: Record<string, unknown>): ClassifierAnswer {
	if (answer.type === "refusal") throw new Error(`${LABEL} refused to answer ${id}`);
	if (question.type === "choice") {
		if (answer.type !== "choice" || typeof answer.choice !== "string") {
			throw new Error(`${LABEL} did not return a choice answer for ${id}`);
		}
		return {
			type: "choice",
			choice: answer.choice,
			probabilities: choiceProbabilities(answer.probabilities, id),
			confidence: requiredNumber(LABEL, answer.confidence, `confidence for ${id}`),
		};
	}
	if (question.type === "score") {
		if (answer.type !== "score") throw new Error(`${LABEL} did not return a score answer for ${id}`);
		return {
			type: "score",
			score: requiredNumber(LABEL, answer.score, `score for ${id}`),
			confidence: requiredNumber(LABEL, answer.confidence, `confidence for ${id}`),
		};
	}
	if (answer.type !== "predicate") throw new Error(`${LABEL} did not return a predicate answer for ${id}`);
	return { type: "bool", probability: requiredNumber(LABEL, answer.probability, `probability for ${id}`) };
}

function parseAnswers(value: unknown, context: ClassifierContext): Record<string, ClassifierAnswer> {
	if (!Array.isArray(value)) throw new Error(`${LABEL} returned an unexpected response`);
	const byName = new Map<string, Record<string, unknown>>();
	for (const answer of value) {
		if (isRecord(answer) && typeof answer.name === "string") byName.set(answer.name, answer);
	}
	return Object.fromEntries(
		Object.entries(context.questions).map(([id, question]) => {
			const answer = byName.get(id);
			if (!answer) throw new Error(`${LABEL} did not return an answer for ${id}`);
			return [id, parseAnswer(id, question, answer)];
		}),
	);
}

/**
 * Cloudflare in front of api.openai.com answers 504 with an HTML page when a request runs longer
 * than about five seconds. Large inputs, currently above roughly 600K tokens, hit this limit, and
 * retrying the same input runs into it again, so 504 is not retried.
 */
const NO_RETRY_STATUSES = [504];

function errorMessage(error: unknown): string {
	if ((error as Partial<ClassifierHttpError>).status === 504) {
		return `${LABEL} error (504): the request timed out at the gateway. Very large inputs (above roughly 600K tokens) currently exceed its time limit.`;
	}
	return formatProviderError(normalizeProviderError(error), `${LABEL} error`);
}

/** Classification through OpenAI's Decisions API. */
export const classify: ClassifierFunction<ClassifierOptions> = async (model, context, options) => {
	const output: ClassifierResult = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		if (model.api !== "openai-decisions") throw new Error(`Unsupported classifier API: ${model.api}`);
		const body = await postClassifierRequest(
			LABEL,
			new URL("decisions", `${model.baseUrl.replace(/\/+$/u, "")}/`),
			model,
			{
				model: model.id,
				input: wireInput(context),
				questions: Object.entries(context.questions).map(([id, question]) => wireQuestion(id, question)),
			},
			options,
			NO_RETRY_STATUSES,
		);
		if (!isRecord(body)) throw new Error(`${LABEL} returned an unexpected response`);
		// Set before parsing answers: a request with malformed or refused answers was still billed.
		const usage = parseClassifierUsage(body.usage, model);
		if (usage) output.usage = usage;
		output.answers = parseAnswers(body.answers, context);
		return output;
	} catch (error) {
		output.answers = {};
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = errorMessage(error);
		return output;
	}
};
